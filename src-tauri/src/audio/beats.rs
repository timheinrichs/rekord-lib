//! Where the beats sit, given a tempo.
//!
//! Roadmap item B3. The tempo detector answers *how fast*; this answers *when* —
//! the phase of the beat grid, which is what a waveform overlay needs and what
//! anything writing ANLZ analysis files (H1) would need first.
//!
//! Deliberately **not** a list of beat positions. Our detector produces one
//! tempo per track by construction, so a grid is fully described by a period and
//! a phase: two numbers, from which every beat follows. Storing a few hundred
//! positions would store the same information with room to disagree with itself.
//! A variable-tempo grid — Rekordbox' "dynamic" mode — would need more, and that
//! is a different feature.

use serde::{Deserialize, Serialize};

use super::bpm;

/// Beat phase within one period, plus how clearly it stood out.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BeatGrid {
    /// Seconds from the start of the analysed excerpt to the first beat. Always
    /// less than one beat period — a grid has no "first" beat, only a phase.
    pub offset_secs: f32,
    /// 0..1, from how far the winning phase beat the average of all phases. A
    /// track with no clear downbeat placement scores low, and something has to
    /// say so before the grid is drawn over a waveform as if it were fact.
    pub confidence: f32,
}

/// Minimum response ratio before a phase counts as found. Below this the comb
/// filter is picking noise, which on an onset curve means there is no pulse to
/// lock to — spoken word, ambient, a badly smeared live recording.
const MIN_PHASE_RATIO: f32 = 1.25;

/// Where the comb response saturates, for scaling the confidence. Measured on
/// click tracks, which reach 4–6; real music sits lower.
const STRONG_PHASE_RATIO: f32 = 3.0;

/// How far the onset curve lags the audio, in envelope frames.
///
/// The sign is the easy thing to get backwards. A frame covers
/// `[i * HOP, i * HOP + FRAME)`, and its flux peaks when the transient sits at
/// the window's *centre* — so the peak lands `FRAME / (2 * HOP)` frames
/// **before** the transient, and `onset_envelope` discarding its first frame
/// shifts every stored index one further back. The correction is therefore
/// added, not subtracted; subtracting it doubled the error from 0.07 of a beat
/// to 0.13, which is how the sign was settled.
///
/// The tempo detector never needed this — it measures *distances* between
/// peaks, where a constant lag cancels. An absolute phase is the first thing
/// here that does, and without the correction a click track's grid came out
/// 0.07 of a beat late, consistently.
const ENVELOPE_LAG_FRAMES: f32 = (bpm::FRAME / (2 * bpm::HOP)) as f32 + 1.0;

/// Finds the beat phase for a known tempo. `None` when the signal has no pulse
/// to lock onto, or when the excerpt is too short to hold several beats.
///
/// Works by comb filtering: for every candidate phase, sum the onset curve at
/// that phase and every beat period after it. The phase that collects the most
/// onset energy is where the beats are. This is the same idea the tempo detector
/// uses — a periodic structure in the onset curve — asked the other way round:
/// the period is known, the offset is not.
pub fn detect_beats(samples: &[i16], sample_rate: u32, bpm: f32) -> Option<BeatGrid> {
    if !(bpm.is_finite() && bpm > 0.0) {
        return None;
    }
    let (envelope, env_rate) = bpm::onset_envelope(samples, sample_rate)?;
    let envelope = bpm::subtract_moving_mean(
        &envelope,
        (bpm::ENVELOPE_SMOOTH_SECS * env_rate) as usize,
    );

    let period = env_rate * 60.0 / bpm;
    if !(period.is_finite() && period >= 2.0) {
        return None;
    }
    // Several beats or the phase means nothing: with two beats in the window,
    // every phase collects almost the same energy.
    let beats = (envelope.len() as f32 / period).floor() as usize;
    if beats < 8 {
        return None;
    }

    // One candidate per envelope frame within the first period. Finer than that
    // would be guessing: the envelope's own resolution is the limit.
    let candidates = period.round().max(2.0) as usize;
    let mut best = (0usize, f32::MIN);
    let mut total = 0.0;
    for phase in 0..candidates {
        let mut sum = 0.0;
        for beat in 0..beats {
            let at = phase as f32 + period * beat as f32;
            // Nearest frame rather than interpolated: the envelope is already a
            // smoothed curve, and rounding costs less than half a frame (2.9 ms).
            let index = at.round() as usize;
            if index < envelope.len() {
                sum += envelope[index];
            }
        }
        total += sum;
        if sum > best.1 {
            best = (phase, sum);
        }
    }

    let mean = total / candidates as f32;
    if mean <= 0.0 || best.1 < mean * MIN_PHASE_RATIO {
        return None;
    }
    let ratio = best.1 / mean;
    let confidence = ((ratio - MIN_PHASE_RATIO) / (STRONG_PHASE_RATIO - MIN_PHASE_RATIO))
        .clamp(0.0, 1.0);
    // Undo the curve's lag, then fold back into the first period: a grid has a
    // phase, not a first beat, and a negative offset would be the same grid
    // spelled confusingly.
    let phase = (best.0 as f32 + ENVELOPE_LAG_FRAMES).rem_euclid(period);
    Some(BeatGrid {
        offset_secs: phase / env_rate,
        confidence,
    })
}

/// The phase difference between two grids of the same tempo, as a fraction of a
/// beat: 0 is identical, 0.5 is maximally wrong (our beats on their off-beats).
///
/// Lives here rather than in the benchmark because it is the only sensible way
/// to compare two grids, and getting it wrong — comparing raw seconds — would
/// score a perfect grid as badly wrong whenever the two happened to name
/// different beats.
pub fn phase_error(a_secs: f32, b_secs: f32, bpm: f32) -> f32 {
    if !(bpm.is_finite() && bpm > 0.0) {
        return 0.0;
    }
    let period = 60.0 / bpm;
    let diff = ((a_secs - b_secs) / period).rem_euclid(1.0);
    // Beyond half a beat, the nearer neighbour is the next beat along.
    diff.min(1.0 - diff)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = 11025;

    /// A click track whose first beat sits at `offset` seconds.
    fn clicks(bpm: f32, secs: f32, offset: f32) -> Vec<i16> {
        let total = (SR as f32 * secs) as usize;
        let mut out = vec![0i16; total];
        let period = SR as f32 * 60.0 / bpm;
        let burst = (SR as f32 * 0.02) as usize;
        let mut beat = 0usize;
        loop {
            let start = (offset * SR as f32 + beat as f32 * period) as usize;
            if start >= total {
                break;
            }
            for i in 0..burst {
                if start + i >= total {
                    break;
                }
                let decay = (-(i as f32) / (burst as f32 * 0.3)).exp();
                let tone = (2.0 * std::f32::consts::PI * 100.0 * i as f32 / SR as f32).sin();
                out[start + i] = (tone * decay * 20_000.0) as i16;
            }
            beat += 1;
        }
        out
    }

    #[test]
    fn finds_the_phase_of_a_click_track() {
        // The core claim: told the tempo, it says where the beats are.
        for offset in [0.0f32, 0.1, 0.23, 0.4] {
            let got = detect_beats(&clicks(120.0, 30.0, offset), SR, 120.0)
                .unwrap_or_else(|| panic!("no grid at offset {offset}"));
            let err = phase_error(got.offset_secs, offset, 120.0);
            assert!(err < 0.05, "offset {offset}: phase off by {err} of a beat");
        }
    }

    #[test]
    fn finds_the_phase_at_several_tempos() {
        for bpm in [90.0f32, 128.0, 174.0] {
            let got = detect_beats(&clicks(bpm, 30.0, 0.15), SR, bpm)
                .unwrap_or_else(|| panic!("no grid at {bpm}"));
            let err = phase_error(got.offset_secs, 0.15, bpm);
            assert!(err < 0.06, "{bpm} BPM: phase off by {err} of a beat");
        }
    }

    #[test]
    fn a_metronome_is_reported_as_confident() {
        let got = detect_beats(&clicks(128.0, 30.0, 0.0), SR, 128.0).expect("no grid");
        assert!(got.confidence > 0.5, "got {}", got.confidence);
    }

    #[test]
    fn returns_none_without_a_pulse() {
        // Silence has no phase, and neither does a steady tone. Drawing a grid
        // over either would be inventing one.
        assert!(detect_beats(&vec![0i16; SR as usize * 30], SR, 128.0).is_none());
        let tone: Vec<i16> = (0..SR as usize * 30)
            .map(|i| {
                let t = i as f32 / SR as f32;
                ((2.0 * std::f32::consts::PI * 220.0 * t).sin() * 12_000.0) as i16
            })
            .collect();
        assert!(detect_beats(&tone, SR, 128.0).is_none());
    }

    #[test]
    fn refuses_a_window_too_short_to_hold_a_phase() {
        // Two beats and every phase collects the same energy, so the answer
        // would be arbitrary.
        assert!(detect_beats(&clicks(120.0, 1.0, 0.0), SR, 120.0).is_none());
        assert!(detect_beats(&[], SR, 120.0).is_none());
    }

    #[test]
    fn refuses_an_impossible_tempo() {
        let samples = clicks(120.0, 30.0, 0.0);
        for bpm in [0.0, -120.0, f32::NAN, f32::INFINITY] {
            assert!(detect_beats(&samples, SR, bpm).is_none(), "accepted {bpm}");
        }
    }

    #[test]
    fn phase_error_measures_the_nearest_beat() {
        // 120 BPM: half a second per beat. A whole beat apart is not an error —
        // the grids name different beats but describe the same grid.
        assert!(phase_error(0.0, 0.5, 120.0) < 1e-6);
        assert!(phase_error(0.0, 2.0, 120.0) < 1e-6);
        // A quarter beat off is 0.25, whichever way round.
        assert!((phase_error(0.125, 0.0, 120.0) - 0.25).abs() < 1e-6);
        assert!((phase_error(0.0, 0.125, 120.0) - 0.25).abs() < 1e-6);
        // Half a beat is the worst it gets: our beats on their off-beats.
        assert!((phase_error(0.25, 0.0, 120.0) - 0.5).abs() < 1e-6);
        // Just past half wraps back towards the next beat.
        assert!(phase_error(0.3, 0.0, 120.0) < 0.5);
    }

    #[test]
    fn phase_error_survives_a_useless_tempo() {
        assert_eq!(phase_error(0.1, 0.2, 0.0), 0.0);
        assert_eq!(phase_error(0.1, 0.2, f32::NAN), 0.0);
    }
}
