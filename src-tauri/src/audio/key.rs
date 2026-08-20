//! Musical key detection.
//!
//! Split like the tempo detector: [`detect_key`] is pure DSP over decoded
//! samples, [`analyze_key`] adds the ffmpeg decode.
//!
//! The approach is the standard one — fold the spectrum into twelve pitch
//! classes, then correlate that against a profile of what each key's pitch
//! distribution looks like. Written rather than bought: `stratum-dsp` was
//! measured at 29.6 % exact against a 2180-track Rekordbox reference where its
//! own README claims 72.1 %, so the cheap path was not one
//! (`docs/DSP_BENCHMARK.md`).

use rustfft::{num_complex::Complex32, FftPlanner};
use serde::{Deserialize, Serialize};


// The decode rate lives in `super::analysis`, which owns the decode all three
// detectors share.

/// Long frame on purpose: 8192 samples at 11 kHz is 743 ms and 1.35 Hz per bin.
/// A semitone at the bottom of the range examined is 3.2 Hz wide, so a shorter
/// frame would smear neighbouring notes into one pitch class.
const FRAME: usize = 8192;
const HOP: usize = 4096;

/// MIDI range folded into pitch classes: C1 (32.7 Hz) to C7 (2093 Hz). Below
/// that is bass fundamentals too broad to place, above it mostly harmonics that
/// blur the profile.
const MIN_MIDI: f32 = 24.0;
const MAX_MIDI: f32 = 96.0;

/// Minimum correlation with the winning profile. Below this the chroma is not
/// shaped like *any* key — atonal material, a drum loop, a field recording —
/// and no answer is better than a wrong one written into a file.
const MIN_CORRELATION: f32 = 0.30;

/// Minimum coefficient of variation of the chroma before its *shape* is
/// believed.
///
/// This gate exists because the correlation above cannot do the job on its own:
/// Pearson is scale-invariant, so a chroma that is flat to within a thousandth
/// still correlates perfectly with whichever profile its noise happens to
/// resemble. White noise was confidently reported as A minor that way.
///
/// Measured on the synthetic material in the tests: white noise sits at 0.012, a
/// scale at 1.24, a triad at 1.73, a single tone at 3.30. The threshold keeps an
/// order of magnitude of margin above noise and below real material.
const MIN_CHROMA_VARIATION: f32 = 0.10;

/// A key as a pitch class plus a mode.
///
/// The only representation worth comparing in: Rekordbox exports a mix of sharps
/// and flats ("F#m", "Abm", "Db"), other tools emit sharps only, and Camelot is a
/// third spelling of the same thing. Comparing strings would score `Abm` against
/// `G#m` as a miss.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MusicalKey {
    /// 0 = C, 1 = C#/Db, … 11 = B.
    pub pc: u8,
    pub minor: bool,
}

impl MusicalKey {
    pub fn new(pc: u8, minor: bool) -> Self {
        Self { pc: pc % 12, minor }
    }

    /// Camelot wheel position, in the convention Rekordbox and Mixed In Key use:
    /// **A = minor, B = major**, 8A = A minor, 8B = C major, one step up the
    /// number is one fifth up.
    ///
    /// Worth stating because it is not universal — `stratum_dsp::Key::numerical()`
    /// uses the inverse (A = major, 1A = C), and writing that into a tag as
    /// "Camelot" would put every track on the wrong spoke of the wheel.
    pub fn camelot(&self) -> (u8, bool) {
        let base: i32 = if self.minor { 9 } else { 0 };
        let n = (8 + (self.pc as i32 - base) * 7).rem_euclid(12);
        (if n == 0 { 12 } else { n as u8 }, !self.minor)
    }

    /// The spelling written into tags: sharps, minor as a trailing `m` — the
    /// same shape Rekordbox writes ("Am", "F#m", "C").
    pub fn name(&self) -> String {
        const NOTES: [&str; 12] = [
            "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
        ];
        format!(
            "{}{}",
            NOTES[self.pc as usize % 12],
            if self.minor { "m" } else { "" }
        )
    }

    /// `"8A"` / `"12B"`, for display next to the name.
    pub fn camelot_name(&self) -> String {
        let (n, is_major) = self.camelot();
        format!("{n}{}", if is_major { "B" } else { "A" })
    }

    /// Parses any of the spellings involved: `"Am"`, `"F#m"`, `"Abm"`, `"C"`,
    /// spelled-out modes (`"A minor"`), and Camelot (`"8A"`). `None` for an empty
    /// or unrecognised value, which is how "no key" travels through.
    pub fn parse(raw: &str) -> Option<Self> {
        let text = raw.trim();
        if text.is_empty() {
            return None;
        }

        // Camelot first: the only form starting with a digit.
        if text.chars().next()?.is_ascii_digit() {
            let (number, letter) = text.split_at(text.len() - 1);
            let number: i32 = number.trim().parse().ok()?;
            if !(1..=12).contains(&number) {
                return None;
            }
            let minor = match letter.trim().to_ascii_uppercase().as_str() {
                "A" => true,
                "B" => false,
                _ => return None,
            };
            let base: i32 = if minor { 9 } else { 0 };
            return Some(Self::new(
                (base + 7 * (number - 8)).rem_euclid(12) as u8,
                minor,
            ));
        }

        let mut chars = text.chars();
        let mut pc: i32 = match chars.next()?.to_ascii_uppercase() {
            'C' => 0,
            'D' => 2,
            'E' => 4,
            'F' => 5,
            'G' => 7,
            'A' => 9,
            'B' => 11,
            _ => return None,
        };
        let mut rest = chars.as_str();
        if let Some(first) = rest.chars().next() {
            match first {
                '#' | '\u{266f}' => {
                    pc += 1;
                    rest = &rest[first.len_utf8()..];
                }
                'b' | '\u{266d}' => {
                    pc -= 1;
                    rest = &rest[first.len_utf8()..];
                }
                _ => {}
            }
        }
        let minor = match rest.trim().to_ascii_lowercase().as_str() {
            "" | "maj" | "major" => false,
            "m" | "min" | "minor" => true,
            _ => return None,
        };
        Some(Self::new(pc.rem_euclid(12) as u8, minor))
    }
}

/// A detected key and how clearly it won.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct DetectedKey {
    pub key: MusicalKey,
    /// 0..1, from how far the winning profile beat the runner-up. A track that
    /// correlates almost equally with two keys is not a confident answer, and
    /// the runner-up is usually the relative or the fifth — exactly the mistakes
    /// key detectors make.
    pub confidence: f32,
}

/// Which set of key profiles to correlate against.
///
/// Three of them because the literature disagrees and the choice is measurable:
/// see `docs/DSP_BENCHMARK.md` for how they scored against 2180 Rekordbox keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profiles {
    /// Krumhansl & Kessler, from listener probe-tone experiments.
    KrumhanslKessler,
    /// Temperley's revision, fitted to a corpus of notated music.
    Temperley,
    /// Shaath, as used by KeyFinder — tuned on electronic music.
    Shaath,
}

impl Profiles {
    /// `(major, minor)`, both starting at the tonic.
    fn weights(self) -> ([f32; 12], [f32; 12]) {
        match self {
            Profiles::KrumhanslKessler => (
                [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88],
                [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17],
            ),
            Profiles::Temperley => (
                [
                    0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366,
                    0.057, 0.400,
                ],
                [
                    0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.067,
                    0.133, 0.330,
                ],
            ),
            Profiles::Shaath => (
                [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4],
                [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2],
            ),
        }
    }
}

/// The profile set the app uses. Picked by measurement, not by preference.
pub const DEFAULT_PROFILES: Profiles = Profiles::Shaath;

/// Detects the key of mono PCM samples with the default profiles.
pub fn detect_key(samples: &[i16], sample_rate: u32) -> Option<DetectedKey> {
    detect_key_with(samples, sample_rate, DEFAULT_PROFILES)
}

/// Detects the key, or `None` when nothing tonal stands out. Pure.
pub fn detect_key_with(
    samples: &[i16],
    sample_rate: u32,
    profiles: Profiles,
) -> Option<DetectedKey> {
    let chroma = chroma(samples, sample_rate)?;
    let (major, minor) = profiles.weights();

    // Every tonic against both modes: 24 candidates, scored by how well the
    // chroma matches that key's expected pitch distribution.
    let mut scored: Vec<(MusicalKey, f32)> = Vec::with_capacity(24);
    for tonic in 0..12u8 {
        for (weights, is_minor) in [(&major, false), (&minor, true)] {
            // Rotate the chroma so the candidate tonic sits at index 0, which is
            // where every profile starts.
            let rotated: Vec<f32> = (0..12)
                .map(|i| chroma[(i + tonic as usize) % 12])
                .collect();
            scored.push((
                MusicalKey::new(tonic, is_minor),
                correlation(&rotated, weights),
            ));
        }
    }
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));

    let (key, best) = scored[0];
    if best < MIN_CORRELATION {
        return None;
    }
    let runner_up = scored[1].1;
    // How clearly it won, relative to the winner's own strength. A margin of
    // zero means two keys explain the track equally well.
    let confidence = ((best - runner_up) / best.abs().max(f32::EPSILON)).clamp(0.0, 1.0);
    Some(DetectedKey { key, confidence })
}

/// Folds the spectrum into twelve pitch classes, normalised to a maximum of 1.
/// `None` when there is not enough audio, or no tonal energy at all.
fn chroma(samples: &[i16], sample_rate: u32) -> Option<[f32; 12]> {
    if samples.len() < FRAME * 2 || sample_rate == 0 {
        return None;
    }
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FRAME);
    let window = hann(FRAME);
    let bins = FRAME / 2 + 1;

    // Which pitch class each FFT bin belongs to, computed once: the mapping
    // depends only on the frame size and the rate, and doing it per frame would
    // dominate the run time.
    let mut bin_pc = vec![None; bins];
    for (k, slot) in bin_pc.iter_mut().enumerate().skip(1) {
        let freq = k as f32 * sample_rate as f32 / FRAME as f32;
        let midi = 69.0 + 12.0 * (freq / 440.0).log2();
        if midi >= MIN_MIDI && midi <= MAX_MIDI {
            *slot = Some((midi.round() as i32).rem_euclid(12) as usize);
        }
    }

    // How many bins land in each pitch class. Bin width is constant in Hz while
    // a semitone widens with pitch, so without dividing this out the top of the
    // range contributes more than the bottom and the chroma of *any* broadband
    // signal comes out lumpy — white noise scored a confident A minor that way.
    let mut bins_per_pc = [0f32; 12];
    for pc in bin_pc.iter().flatten() {
        bins_per_pc[*pc] += 1.0;
    }

    let mut chroma = [0f32; 12];
    let mut buf = vec![Complex32::new(0.0, 0.0); FRAME];
    let mut pos = 0;
    let mut frames = 0f32;
    while pos + FRAME <= samples.len() {
        for i in 0..FRAME {
            let s = samples[pos + i] as f32 / 32768.0;
            buf[i] = Complex32::new(s * window[i], 0.0);
        }
        fft.process(&mut buf);

        let mut frame_chroma = [0f32; 12];
        for (k, slot) in bin_pc.iter().enumerate().take(bins) {
            if let Some(pc) = slot {
                frame_chroma[*pc] += buf[k].norm();
            }
        }
        // Per pitch class, not per bin: a semitone widens with pitch while the
        // bin width does not, so without this the top of the range contributes
        // more than the bottom and any broadband signal comes out lumpy.
        for (v, count) in frame_chroma.iter_mut().zip(&bins_per_pc) {
            if *count > 0.0 {
                *v /= count;
            }
        }
        // Each frame contributes equally once normalised, so a loud drop does
        // not outvote three quiet minutes of the same track.
        let frame_max = frame_chroma.iter().copied().fold(0.0f32, f32::max);
        if frame_max > 0.0 {
            for (total, v) in chroma.iter_mut().zip(&frame_chroma) {
                *total += v / frame_max;
            }
            frames += 1.0;
        }
        pos += HOP;
    }
    if frames == 0.0 {
        return None;
    }

    let max = chroma.iter().copied().fold(0.0f32, f32::max);
    if max <= 0.0 {
        return None;
    }
    for v in chroma.iter_mut() {
        *v /= max;
    }

    // A flat chroma has no shape worth matching — see MIN_CHROMA_VARIATION.
    let mean = chroma.iter().sum::<f32>() / 12.0;
    if mean <= 0.0 {
        return None;
    }
    let variation =
        (chroma.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / 12.0).sqrt() / mean;
    if variation < MIN_CHROMA_VARIATION {
        return None;
    }
    Some(chroma)
}

/// Pearson correlation of two twelve-element vectors. Zero when either is flat,
/// which is what makes silence and noise fall through the `MIN_CORRELATION`
/// gate rather than matching an arbitrary key.
fn correlation(a: &[f32], b: &[f32]) -> f32 {
    let n = a.len() as f32;
    let mean_a = a.iter().sum::<f32>() / n;
    let mean_b = b.iter().sum::<f32>() / n;
    let mut cov = 0.0;
    let mut var_a = 0.0;
    let mut var_b = 0.0;
    for (x, y) in a.iter().zip(b) {
        let da = x - mean_a;
        let db = y - mean_b;
        cov += da * db;
        var_a += da * da;
        var_b += db * db;
    }
    let denom = (var_a * var_b).sqrt();
    if denom <= f32::EPSILON {
        0.0
    } else {
        cov / denom
    }
}

fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| {
            let x = std::f32::consts::PI * 2.0 * i as f32 / n as f32;
            0.5 - 0.5 * x.cos()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The rate `analysis` decodes at. A literal, like the tempo tests use: these
    /// are about the DSP, not about the pipeline's choice of rate.
    const SR: u32 = 11025;

    /// A chord as a sum of notes, each with an octave partial.
    ///
    /// Octaves only, on purpose: a third harmonic adds a fifth above every note,
    /// which turns a C major triad into C-E-G-B-D — where E minor is a perfectly
    /// good reading. A test signal has to have one answer, so the harmonics stop
    /// where they would start adding pitch classes.
    fn chord(freqs: &[f32], secs: f32) -> Vec<i16> {
        let total = (SR as f32 * secs) as usize;
        (0..total)
            .map(|i| {
                let t = i as f32 / SR as f32;
                let mut sum = 0.0;
                for f in freqs {
                    let w = 2.0 * std::f32::consts::PI * t;
                    sum += (w * f).sin();
                    if f * 2.0 < SR as f32 / 2.0 {
                        sum += 0.5 * (w * f * 2.0).sin();
                    }
                }
                ((sum / (freqs.len() as f32 * 1.5)) * 18_000.0) as i16
            })
            .collect()
    }

    // Equal temperament, A4 = 440.
    const C4: f32 = 261.626;
    const D4: f32 = 293.665;
    const E4: f32 = 329.628;
    const F4: f32 = 349.228;
    const G4: f32 = 391.995;
    const A4: f32 = 440.0;
    const B4: f32 = 493.883;
    const C5: f32 = 523.251;

    #[test]
    fn a_single_tone_lands_in_its_own_pitch_class() {
        // The foundation everything else rests on: if the bin-to-pitch-class
        // mapping is off by one, every key is off by a fifth.
        for (freq, pc) in [(C4, 0), (E4, 4), (G4, 7), (A4, 9)] {
            let c = chroma(&chord(&[freq], 6.0), SR).expect("chroma");
            let loudest = (0..12).max_by(|a, b| c[*a].total_cmp(&c[*b])).unwrap();
            assert_eq!(loudest, pc, "{freq} Hz landed in pitch class {loudest}");
        }
    }

    #[test]
    fn detects_a_major_triad_as_its_major_key() {
        let got = detect_key(&chord(&[C4, E4, G4], 8.0), SR).expect("no key");
        assert_eq!(got.key, MusicalKey::new(0, false), "got {}", got.key.name());
    }

    #[test]
    fn detects_a_minor_triad_as_its_minor_key() {
        let got = detect_key(&chord(&[A4, C5, E4], 8.0), SR).expect("no key");
        assert_eq!(got.key, MusicalKey::new(9, true), "got {}", got.key.name());
    }

    #[test]
    fn tells_a_scale_apart_from_its_relative() {
        // The hardest distinction in key detection, and the one that separates a
        // useful answer from a coin flip: C major and A minor share all seven
        // notes, and only the weighting of the tonic and third tells them apart.
        let c_major = chord(&[C4, C4, E4, G4, C5, D4, F4, B4], 8.0);
        let got = detect_key(&c_major, SR).expect("no key");
        assert!(
            !got.key.minor && got.key.pc == 0,
            "a C-weighted major scale read as {}",
            got.key.name()
        );
    }

    #[test]
    fn returns_none_for_silence_and_noise() {
        // Nothing tonal, so no key — the same stance the tempo detector takes.
        assert!(detect_key(&vec![0i16; SR as usize * 8], SR).is_none());

        let mut state = 12345u32;
        let noise: Vec<i16> = (0..SR as usize * 8)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                ((state >> 16) as i16).wrapping_sub(16384)
            })
            .collect();
        // White noise fills every pitch class equally, so no profile fits.
        let got = detect_key(&noise, SR);
        assert!(got.is_none(), "noise was given the key {:?}", got);
    }

    #[test]
    fn returns_none_for_too_little_audio() {
        assert!(detect_key(&[], SR).is_none());
        assert!(detect_key(&vec![0i16; FRAME], SR).is_none());
    }

    #[test]
    fn confidence_is_higher_for_a_clear_chord_than_for_an_ambiguous_one() {
        // A bare triad is unambiguous; two notes a tritone apart belong to no
        // key in particular, and the value has to say so.
        let clear = detect_key(&chord(&[C4, E4, G4], 8.0), SR).expect("triad");
        let vague = detect_key(&chord(&[C4, F4 * 1.0595], 8.0), SR);
        if let Some(vague) = vague {
            assert!(
                clear.confidence > vague.confidence,
                "clear {} vs vague {}",
                clear.confidence,
                vague.confidence
            );
        }
        assert!((0.0..=1.0).contains(&clear.confidence));
    }

    #[test]
    fn every_profile_set_agrees_on_a_bare_triad() {
        // They differ on real music, which is why the choice is measured — but a
        // plain C major triad is not where they should disagree.
        for profiles in [
            Profiles::KrumhanslKessler,
            Profiles::Temperley,
            Profiles::Shaath,
        ] {
            let got = detect_key_with(&chord(&[C4, E4, G4], 8.0), SR, profiles)
                .unwrap_or_else(|| panic!("no key from {profiles:?}"));
            assert_eq!(
                got.key,
                MusicalKey::new(0, false),
                "{profiles:?} said {}",
                got.key.name()
            );
        }
    }

    // --- MusicalKey ------------------------------------------------------

    #[test]
    fn camelot_follows_the_rekordbox_convention() {
        // 8A = A minor, 8B = C major, A = minor. Asserted because it is not
        // universal: stratum-dsp uses the inverse.
        assert_eq!(MusicalKey::parse("Am").unwrap().camelot(), (8, false));
        assert_eq!(MusicalKey::parse("C").unwrap().camelot(), (8, true));
        assert_eq!(MusicalKey::parse("Em").unwrap().camelot(), (9, false));
        assert_eq!(MusicalKey::parse("G").unwrap().camelot(), (9, true));
        assert_eq!(MusicalKey::parse("Dm").unwrap().camelot(), (7, false));
        assert_eq!(MusicalKey::parse("E").unwrap().camelot(), (12, true));
        assert_eq!(MusicalKey::parse("Abm").unwrap().camelot(), (1, false));
    }

    #[test]
    fn parses_every_spelling_that_turns_up() {
        let am = MusicalKey::new(9, true);
        for text in ["Am", "am", " Am ", "A minor", "Amin", "8A"] {
            assert_eq!(MusicalKey::parse(text), Some(am), "failed on {text:?}");
        }
        let c = MusicalKey::new(0, false);
        for text in ["C", "C major", "Cmaj", "8B"] {
            assert_eq!(MusicalKey::parse(text), Some(c), "failed on {text:?}");
        }
    }

    #[test]
    fn enharmonic_spellings_are_the_same_key() {
        assert_eq!(MusicalKey::parse("Abm"), MusicalKey::parse("G#m"));
        assert_eq!(MusicalKey::parse("Db"), MusicalKey::parse("C#"));
        assert_eq!(MusicalKey::parse("F\u{266f}m"), MusicalKey::parse("F#m"));
        assert_eq!(MusicalKey::parse("Cb"), Some(MusicalKey::new(11, false)));
        assert_eq!(MusicalKey::parse("B#"), Some(MusicalKey::new(0, false)));
    }

    #[test]
    fn rejects_what_is_not_a_key() {
        for text in ["", "   ", "H", "Xm", "13A", "0A", "8C", "Am7", "minor"] {
            assert_eq!(MusicalKey::parse(text), None, "accepted {text:?}");
        }
    }

    #[test]
    fn names_round_trip_through_parsing() {
        for pc in 0..12u8 {
            for minor in [false, true] {
                let key = MusicalKey::new(pc, minor);
                assert_eq!(MusicalKey::parse(&key.name()), Some(key));
                assert_eq!(MusicalKey::parse(&key.camelot_name()), Some(key));
            }
        }
    }

    #[test]
    fn names_are_what_rekordbox_writes() {
        assert_eq!(MusicalKey::new(9, true).name(), "Am");
        assert_eq!(MusicalKey::new(0, false).name(), "C");
        assert_eq!(MusicalKey::new(6, true).name(), "F#m");
        assert_eq!(MusicalKey::new(9, true).camelot_name(), "8A");
        assert_eq!(MusicalKey::new(0, false).camelot_name(), "8B");
    }
}
