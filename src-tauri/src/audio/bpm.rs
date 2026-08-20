//! Tempo (BPM) detection.
//!
//! Split in two: [`detect_bpm`] is pure DSP over decoded samples (unit-tested
//! below with synthetic click tracks), [`analyze_bpm`] only adds the ffmpeg
//! decode — the same sidecar pipeline the fingerprint uses.
//!
//! The result carries a [`Tempo`]: an unrounded BPM plus a confidence. Both
//! matter downstream. Rekordbox stores fractional tempos and 1042 of the 2180
//! tracks in our reference set are not integers (`docs/DSP_BENCHMARK.md`), so
//! rounding threw away real information; and the confidence is what lets the
//! scan refuse to overwrite an existing tag with a weak guess.

use rustfft::{num_complex::Complex32, FftPlanner};
use tauri::AppHandle;

use super::decode;
use crate::error::{AppError, AppResult};

/// Sample rate we decode to. Beat energy lives far below the 5.5 kHz Nyquist,
/// and it matches the fingerprint pipeline (same decoder settings, same cost).
const SAMPLE_RATE: u32 = 11025;

/// Seconds decoded per file.
const EXCERPT_SECS: u32 = 120;

/// Offset into the track, so intros/ambient starts do not dominate.
const EXCERPT_OFFSET_SECS: u32 = 30;

/// FFT frame (46 ms at 11025 Hz) and hop (5.8 ms → ~172 Hz envelope).
/// The small hop is what makes the tempo grid fine enough: at a coarser hop,
/// neighbouring autocorrelation lags around 130 BPM are several BPM apart.
const FRAME: usize = 512;
const HOP: usize = 64;

/// Tempo search range before octave correction.
const MIN_BPM: f32 = 60.0;
const MAX_BPM: f32 = 200.0;

/// Tempo preference curve: centre and width (in octaves) of a log-normal prior
/// over plausible tempos. An autocorrelation peak cannot distinguish a tempo
/// from its half or double — a 137 BPM track correlates at 68.5 just as well,
/// usually better — so the octave is decided by musical likelihood instead.
/// Measured on real 137/140 BPM releases, the correct octave scored only
/// 0.44–0.74 of the half-tempo peak, which no plain threshold separates from
/// genuine downtempo.
///
/// Tuned against 21 tracks with Rekordbox reference values: 7/21 before,
/// 15/21 after. These sit in the middle of a broad plateau (centre 140–155,
/// width 0.30–0.50 all score alike) rather than at the fitted optimum, because
/// the reference set leans heavily on one 160 BPM footwork compilation and a
/// sharper prior would drag the library's 120–140 BPM mass upwards.
const PRIOR_CENTRE_BPM: f32 = 140.0;
const PRIOR_WIDTH_OCTAVES: f32 = 0.45;

/// Ratios the true tempo may sit at relative to the strongest correlation peak.
/// Powers of two alone are not enough: shuffled and triplet-heavy material
/// (footwork, jungle, swing) peaks at two thirds or four thirds of the beat,
/// which measured as a solid quarter of all errors on the reference set.
const OCTAVE_FACTORS: [f32; 11] = [
    0.25,
    1.0 / 3.0,
    0.5,
    2.0 / 3.0,
    0.75,
    1.0,
    4.0 / 3.0,
    1.5,
    2.0,
    3.0,
    4.0,
];

/// Window of the moving-mean subtraction on the onset envelope (seconds).
const ENVELOPE_SMOOTH_SECS: f32 = 0.5;

/// Confidence gates. A wrong number written into thousands of files is worse
/// than no number, so an unconvincing peak yields `None`.
const MIN_PEAK_CORRELATION: f32 = 0.10;
const MIN_PEAK_RATIO: f32 = 1.30;

/// Where the two confidence components saturate. A peak correlating at 0.5, or
/// standing three times above the mean of the searched range, is as convincing
/// as this detector gets — beyond that the number says nothing more.
///
/// These only scale the reported confidence; they are not gates. The gates above
/// decide whether there is an answer at all, which is why a value that barely
/// passes them reports a confidence near zero rather than a comfortable one.
const STRONG_PEAK_CORRELATION: f32 = 0.50;
const STRONG_PEAK_RATIO: f32 = 3.00;

/// Minimum envelope length relative to the longest lag examined.
const MIN_PERIODS: usize = 4;

/// A tempo estimate and how strongly the signal supported it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tempo {
    /// Beats per minute, unrounded — Rekordbox stores decimals and so do we.
    pub bpm: f32,
    /// 0..1, where 0 means "only just convincing enough to report at all".
    /// Derived from how strongly the autocorrelation peaked and how far it stood
    /// out from the rest of the searched range.
    pub confidence: f32,
}

/// Decodes an excerpt of a file to mono PCM via the ffmpeg sidecar and detects
/// its tempo. `Ok(None)` means "decoded fine, but no convincing tempo".
pub async fn analyze_bpm(app: &AppHandle, path: &str) -> AppResult<Option<Tempo>> {
    // Skip the intro; fall back to the start for tracks shorter than the offset.
    let decode_at = |offset| decode::mono_pcm(app, path, SAMPLE_RATE, offset, EXCERPT_SECS);
    let samples = match decode_at(EXCERPT_OFFSET_SECS).await {
        Ok(s) if s.len() >= SAMPLE_RATE as usize * 10 => s,
        Ok(_) | Err(_) => decode_at(0).await?,
    };
    // Detection is seconds of pure CPU work. Running it on an async worker
    // thread would block the very runtime the concurrent decodes and the rest
    // of the app share — with one task per core, throughput collapses.
    tauri::async_runtime::spawn_blocking(move || detect_bpm(&samples, SAMPLE_RATE))
        .await
        .map_err(|e| AppError::Probe(format!("BPM task failed: {e}")))
}

/// Detects the tempo of mono PCM samples, or `None` when the signal carries no
/// convincing periodic pulse (silence, noise, spoken word, too short). Pure.
pub fn detect_bpm(samples: &[i16], sample_rate: u32) -> Option<Tempo> {
    let (envelope, env_rate) = onset_envelope(samples, sample_rate)?;
    let envelope = subtract_moving_mean(&envelope, (ENVELOPE_SMOOTH_SECS * env_rate) as usize);

    // Lag (in envelope frames) of a given tempo, and back.
    let lag_of = |bpm: f32| env_rate * 60.0 / bpm;
    let min_lag = lag_of(MAX_BPM).floor().max(2.0) as usize;
    let max_lag = lag_of(MIN_BPM).ceil() as usize;
    if envelope.len() < max_lag * MIN_PERIODS {
        return None;
    }

    let acf = autocorrelation(&envelope, max_lag + 1)?;

    // Strongest lag in the search range, plus the range's mean for the gate.
    let mut best = min_lag;
    let mut sum = 0.0;
    for lag in min_lag..=max_lag {
        sum += acf[lag];
        if acf[lag] > acf[best] {
            best = lag;
        }
    }
    let mean = sum / (max_lag - min_lag + 1) as f32;
    if acf[best] <= 0.0 || acf[best] < MIN_PEAK_CORRELATION || acf[best] < mean * MIN_PEAK_RATIO {
        return None;
    }

    // Sub-lag precision: the integer grid alone is far too coarse up here.
    let refined = refine_peak(&acf, best);
    let bpm = 60.0 * env_rate / refined;

    Some(Tempo {
        bpm: fold_to_preferred(bpm, &acf, env_rate),
        confidence: confidence(acf[best], mean),
    })
}

/// Turns the two quantities the gates already measure into one 0..1 value: how
/// strongly the envelope correlated at the winning lag, and how far that peak
/// stood above the average of the searched range.
///
/// Combined as a geometric mean, so a peak that is strong but unremarkable —
/// or distinct but weak — does not pass for confident. Both have to hold.
fn confidence(peak: f32, range_mean: f32) -> f32 {
    let span = |value: f32, gate: f32, strong: f32| {
        ((value - gate) / (strong - gate)).clamp(0.0, 1.0)
    };
    let strength = span(peak, MIN_PEAK_CORRELATION, STRONG_PEAK_CORRELATION);
    // The ratio is undefined for a flat range; such a signal never gets here,
    // because the gate above rejects it first.
    let ratio = if range_mean > 0.0 {
        peak / range_mean
    } else {
        STRONG_PEAK_RATIO
    };
    let distinctness = span(ratio, MIN_PEAK_RATIO, STRONG_PEAK_RATIO);
    (strength * distinctness).sqrt()
}

/// Half-wave rectified spectral flux per frame, plus the envelope's rate in Hz.
fn onset_envelope(samples: &[i16], sample_rate: u32) -> Option<(Vec<f32>, f32)> {
    if samples.len() < FRAME * 2 || sample_rate == 0 {
        return None;
    }
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FRAME);
    let window = hann(FRAME);
    let bins = FRAME / 2 + 1;

    let mut prev = vec![0f32; bins];
    let mut buf = vec![Complex32::new(0.0, 0.0); FRAME];
    let mut env = Vec::with_capacity(samples.len() / HOP);

    let mut pos = 0;
    let mut first = true;
    while pos + FRAME <= samples.len() {
        for i in 0..FRAME {
            let s = samples[pos + i] as f32 / 32768.0;
            buf[i] = Complex32::new(s * window[i], 0.0);
        }
        fft.process(&mut buf);

        let mut flux = 0.0;
        for (k, slot) in prev.iter_mut().enumerate().take(bins) {
            let mag = buf[k].norm();
            let rise = mag - *slot;
            if rise > 0.0 {
                flux += rise;
            }
            *slot = mag;
        }
        // The first frame's flux is meaningless (previous spectrum is all zero).
        if first {
            first = false;
        } else {
            env.push(flux);
        }
        pos += HOP;
    }

    if env.len() < 16 {
        return None;
    }
    Some((env, sample_rate as f32 / HOP as f32))
}

/// Subtracts a centred moving mean and half-wave rectifies — this is what turns
/// a loudness curve into a peaky onset signal.
fn subtract_moving_mean(env: &[f32], window: usize) -> Vec<f32> {
    let w = window.max(1);
    // Prefix sums keep this O(n) regardless of the window size.
    let mut prefix = Vec::with_capacity(env.len() + 1);
    prefix.push(0.0f32);
    for v in env {
        prefix.push(prefix[prefix.len() - 1] + v);
    }
    env.iter()
        .enumerate()
        .map(|(i, v)| {
            let lo = i.saturating_sub(w);
            let hi = (i + w + 1).min(env.len());
            let mean = (prefix[hi] - prefix[lo]) / (hi - lo) as f32;
            (v - mean).max(0.0)
        })
        .collect()
}

/// Normalised autocorrelation (`acf[0] == 1`) of the zero-mean envelope, for
/// lags `0..=max_lag`. Each lag is averaged over its own overlap, so long lags
/// are not penalised. `None` when the signal is constant (e.g. silence).
fn autocorrelation(env: &[f32], max_lag: usize) -> Option<Vec<f32>> {
    let n = env.len();
    let mean = env.iter().sum::<f32>() / n as f32;
    let centred: Vec<f32> = env.iter().map(|v| v - mean).collect();

    let variance = centred.iter().map(|v| v * v).sum::<f32>() / n as f32;
    if variance <= f32::EPSILON {
        return None;
    }

    let mut acf = Vec::with_capacity(max_lag + 1);
    for lag in 0..=max_lag {
        if lag >= n {
            acf.push(0.0);
            continue;
        }
        let count = n - lag;
        let sum: f32 = (0..count).map(|i| centred[i] * centred[i + lag]).sum();
        acf.push(sum / count as f32 / variance);
    }
    Some(acf)
}

/// Parabolic interpolation around an autocorrelation peak, for sub-lag accuracy.
fn refine_peak(acf: &[f32], peak: usize) -> f32 {
    if peak == 0 || peak + 1 >= acf.len() {
        return peak as f32;
    }
    let (y0, y1, y2) = (acf[peak - 1], acf[peak], acf[peak + 1]);
    let denom = y0 - 2.0 * y1 + y2;
    if denom.abs() < f32::EPSILON {
        return peak as f32;
    }
    let delta = 0.5 * (y0 - y2) / denom;
    // A well-formed peak shifts by less than half a lag; anything else is noise.
    if delta.abs() > 0.5 {
        return peak as f32;
    }
    peak as f32 + delta
}

/// Picks the octave of `bpm` that best explains the signal *and* is the most
/// plausible tempo, scoring each candidate by its autocorrelation weighted with
/// [`tempo_prior`]. Half/double-time is the dominant error mode of every
/// autocorrelation estimator, and the correlation alone cannot break the tie:
/// an isochronous pulse peaks at every multiple of its period.
///
/// Candidates outside the searched range are dropped — there is no measurement
/// to judge them by.
fn fold_to_preferred(bpm: f32, acf: &[f32], env_rate: f32) -> f32 {
    let score = |c: f32| {
        let lag = (env_rate * 60.0 / c).round() as usize;
        // Negative correlation means "no events at this rate"; clamping keeps
        // the prior from turning it into a competitive score.
        acf.get(lag).copied().unwrap_or(f32::MIN).max(0.0) * tempo_prior(c)
    };
    OCTAVE_FACTORS
        .iter()
        .map(|f| bpm * f)
        .filter(|c| *c >= MIN_BPM && *c <= MAX_BPM)
        .fold((bpm, f32::MIN), |best, c| {
            let s = score(c);
            if s > best.1 {
                (c, s)
            } else {
                best
            }
        })
        .0
}

/// Log-normal likelihood of a tempo, peaking at [`PRIOR_CENTRE_BPM`].
fn tempo_prior(bpm: f32) -> f32 {
    let octaves = (bpm / PRIOR_CENTRE_BPM).log2() / PRIOR_WIDTH_OCTAVES;
    (-0.5 * octaves * octaves).exp()
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

    const SR: u32 = SAMPLE_RATE;

    /// Deterministic pseudo-noise (no rand dependency, reproducible tests).
    struct Lcg(u32);
    impl Lcg {
        fn next_f32(&mut self) -> f32 {
            self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (self.0 >> 8) as f32 / (1 << 24) as f32 * 2.0 - 1.0
        }
    }

    /// A click track: a short decaying noise+tone burst on every beat.
    /// `accent` scales every second beat, to model a strong/weak pattern.
    fn click_track(bpm: f32, secs: f32, accent: f32) -> Vec<i16> {
        let total = (SR as f32 * secs) as usize;
        let mut out = vec![0i16; total];
        let mut rng = Lcg(12345);
        let period = SR as f32 * 60.0 / bpm;
        let burst = (SR as f32 * 0.02) as usize; // 20 ms

        let mut beat = 0usize;
        loop {
            let start = (beat as f32 * period) as usize;
            if start >= total {
                break;
            }
            let gain = if beat % 2 == 1 { accent } else { 1.0 };
            for i in 0..burst {
                if start + i >= total {
                    break;
                }
                let decay = (-(i as f32) / (burst as f32 * 0.3)).exp();
                let tone = (2.0 * std::f32::consts::PI * 100.0 * i as f32 / SR as f32).sin();
                let v = (tone * 0.7 + rng.next_f32() * 0.3) * decay * gain;
                out[start + i] = (v * 20_000.0) as i16;
            }
            beat += 1;
        }
        out
    }

    #[test]
    fn detects_common_dance_tempos() {
        for bpm in [100.0, 120.0, 128.0, 140.0, 174.0] {
            let samples = click_track(bpm, 30.0, 1.0);
            let got = detect_bpm(&samples, SR).unwrap_or_else(|| panic!("no BPM at {bpm}"));
            let diff = (got.bpm - bpm).abs();
            assert!(diff <= 1.0, "expected ~{bpm}, got {}", got.bpm);
        }
    }

    #[test]
    fn reports_an_unrounded_tempo() {
        // The whole point of keeping f32: a tempo between two integers has to
        // survive. A click track at 128.5 must not come back as 128 or 129.
        let got = detect_bpm(&click_track(128.5, 40.0, 1.0), SR).expect("no BPM");
        assert!(
            (got.bpm - 128.5).abs() <= 0.6,
            "expected ~128.5, got {}",
            got.bpm
        );
        assert!(
            got.bpm.fract() != 0.0,
            "a rounded value means the fraction was thrown away again"
        );
    }

    #[test]
    fn keeps_downtempo_instead_of_reporting_double_time() {
        // Strong beat, weak off-beat: the 70 BPM period correlates better than
        // the 140 BPM one, so octave folding must not push this to 140.
        let samples = click_track(70.0, 40.0, 0.35);
        let got = detect_bpm(&samples, SR).expect("no BPM detected").bpm;
        assert!((got - 70.0).abs() <= 1.0, "expected ~70, got {got}");
    }

    #[test]
    fn folds_out_of_range_tempo_into_the_preferred_band() {
        // 300 BPM is above the search range; its 150 BPM subharmonic is the
        // musically sensible answer.
        let samples = click_track(300.0, 30.0, 1.0);
        let got = detect_bpm(&samples, SR).expect("no BPM detected").bpm;
        assert!((got - 150.0).abs() <= 1.0, "expected ~150, got {got}");
    }

    #[test]
    fn prefers_the_club_tempo_over_its_half_time_peak() {
        // A backbeat makes the half-tempo period correlate *better* than the
        // beat itself — on real 137/140 BPM releases the correct octave scored
        // only 0.44–0.74 of the half-tempo peak. Picking the stronger peak
        // therefore reports 68 instead of 137, which is what the tempo prior
        // exists to prevent.
        for bpm in [137.0, 140.0] {
            let samples = click_track(bpm, 40.0, 1.8);
            let got = detect_bpm(&samples, SR)
                .unwrap_or_else(|| panic!("no BPM at {bpm}"))
                .bpm;
            assert!(
                (got - bpm).abs() <= 1.0,
                "expected ~{bpm}, got {got} (half time is {})",
                bpm / 2.0
            );
        }
    }

    #[test]
    fn tempo_prior_peaks_in_the_club_range_and_decays_outwards() {
        assert!(tempo_prior(PRIOR_CENTRE_BPM) > 0.99);
        assert!(tempo_prior(128.0) > tempo_prior(64.0));
        assert!(tempo_prior(128.0) > tempo_prior(256.0));
        // Still meaningful at the edges of the searched range, never zero.
        assert!(tempo_prior(60.0) > 0.0 && tempo_prior(200.0) > 0.0);
    }

    #[test]
    fn returns_none_for_silence() {
        assert_eq!(detect_bpm(&vec![0i16; SR as usize * 30], SR), None);
    }

    #[test]
    fn returns_none_for_white_noise() {
        let mut rng = Lcg(7);
        let samples: Vec<i16> = (0..SR as usize * 30)
            .map(|_| (rng.next_f32() * 12_000.0) as i16)
            .collect();
        assert_eq!(detect_bpm(&samples, SR), None);
    }

    #[test]
    fn returns_none_for_too_short_input() {
        // Two seconds cannot hold four periods of the slowest tempo searched.
        assert_eq!(detect_bpm(&click_track(128.0, 2.0, 1.0), SR), None);
        assert_eq!(detect_bpm(&[], SR), None);
        assert_eq!(detect_bpm(&[0i16; 10], SR), None);
    }

    #[test]
    fn a_clean_click_track_is_reported_as_confident() {
        // The confidence exists to gate tag writes, so the easiest possible
        // signal has to land high — otherwise the gate blocks everything.
        let got = detect_bpm(&click_track(128.0, 40.0, 1.0), SR).expect("no BPM");
        assert!(
            got.confidence > 0.5,
            "a metronome should be convincing, got {}",
            got.confidence
        );
    }

    #[test]
    fn confidence_stays_inside_zero_and_one() {
        // Whatever the DSP produces, downstream treats this as a 0..1 value:
        // the UI shows it and the scan compares it against a threshold.
        for (peak, mean) in [
            (0.0, 1.0),
            (MIN_PEAK_CORRELATION, MIN_PEAK_CORRELATION),
            (1.0, 0.0),
            (1.0, 0.000_001),
            (f32::MAX, 1.0),
        ] {
            let c = confidence(peak, mean);
            assert!((0.0..=1.0).contains(&c), "confidence {c} out of range");
        }
    }

    #[test]
    fn confidence_needs_both_strength_and_distinctness() {
        // Geometric mean: excelling at one while sitting at the other's gate is
        // not confidence. This is what keeps a loud but shapeless track from
        // overwriting a tag.
        let strong_but_ordinary = confidence(STRONG_PEAK_CORRELATION, STRONG_PEAK_CORRELATION);
        assert!(
            strong_but_ordinary < 0.1,
            "a peak that does not stand out scored {strong_but_ordinary}"
        );
        let distinct_but_weak = confidence(MIN_PEAK_CORRELATION, MIN_PEAK_CORRELATION / 10.0);
        assert!(
            distinct_but_weak < 0.1,
            "a weak peak scored {distinct_but_weak}"
        );
        // Both strong -> saturated.
        assert!(
            confidence(STRONG_PEAK_CORRELATION, STRONG_PEAK_CORRELATION / STRONG_PEAK_RATIO)
                > 0.99
        );
    }

    #[test]
    fn confidence_grows_with_the_peak() {
        let weak = confidence(0.15, 0.05);
        let mid = confidence(0.30, 0.05);
        let strong = confidence(0.45, 0.05);
        assert!(weak < mid && mid < strong, "{weak} {mid} {strong}");
    }

    #[test]
    fn envelope_has_the_expected_rate_and_length() {
        let samples = vec![0i16; SR as usize * 4];
        let (env, rate) = onset_envelope(&samples, SR).expect("envelope");
        assert!((rate - SR as f32 / HOP as f32).abs() < f32::EPSILON);
        // One frame per hop that fits a full window, minus the discarded first.
        let expected = (samples.len() - FRAME) / HOP + 1 - 1;
        assert_eq!(env.len(), expected);
    }

    #[test]
    fn moving_mean_subtraction_rectifies() {
        let out = subtract_moving_mean(&[0.0, 0.0, 10.0, 0.0, 0.0], 1);
        assert!(out.iter().all(|v| *v >= 0.0));
        assert!(out[2] > 0.0, "the spike must survive");
        assert_eq!(out[0], 0.0);
    }
}
