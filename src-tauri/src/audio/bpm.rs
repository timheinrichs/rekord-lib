//! Tempo (BPM) detection.
//!
//! Split in two: [`detect_bpm`] is pure DSP over decoded samples (unit-tested
//! below with synthetic click tracks), [`analyze_bpm`] only adds the ffmpeg
//! decode — the same sidecar pipeline the fingerprint uses.

use rustfft::{num_complex::Complex32, FftPlanner};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

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

/// Range the result is folded into. Wide enough to keep genuine downtempo
/// (70–100) and drum & bass (174) intact instead of forcing everything to 4/4
/// club tempo.
const PREFERRED_MIN: f32 = 70.0;
const PREFERRED_MAX: f32 = 180.0;

/// Window of the moving-mean subtraction on the onset envelope (seconds).
const ENVELOPE_SMOOTH_SECS: f32 = 0.5;

/// Confidence gates. A wrong number written into thousands of files is worse
/// than no number, so an unconvincing peak yields `None`.
const MIN_PEAK_CORRELATION: f32 = 0.10;
const MIN_PEAK_RATIO: f32 = 1.30;

/// Minimum envelope length relative to the longest lag examined.
const MIN_PERIODS: usize = 4;

/// How close to the best octave's autocorrelation a faster octave must come to
/// be preferred over it. See [`fold_to_preferred`].
const OCTAVE_TOLERANCE: f32 = 0.85;

/// Slack on the preferred band, so an estimate sitting a fraction of a BPM
/// outside it is not flipped to another octave.
const BAND_MARGIN: f32 = 2.0;

/// Decodes an excerpt of a file to mono PCM via the ffmpeg sidecar and detects
/// its tempo. `Ok(None)` means "decoded fine, but no convincing tempo".
pub async fn analyze_bpm(app: &AppHandle, path: &str) -> AppResult<Option<u32>> {
    // Skip the intro; fall back to the start for tracks shorter than the offset.
    let samples = match decode(app, path, EXCERPT_OFFSET_SECS).await {
        Ok(s) if s.len() >= SAMPLE_RATE as usize * 10 => s,
        Ok(_) | Err(_) => decode(app, path, 0).await?,
    };
    Ok(detect_bpm(&samples, SAMPLE_RATE))
}

/// Decodes `EXCERPT_SECS` from `offset` as mono s16le.
async fn decode(app: &AppHandle, path: &str, offset: u32) -> AppResult<Vec<i16>> {
    let off = offset.to_string();
    let dur = EXCERPT_SECS.to_string();
    let sr = SAMPLE_RATE.to_string();
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| AppError::Sidecar(e.to_string()))?
        .args([
            "-v", "error", "-ss", &off, "-i", path, "-map", "0:a:0", "-t", &dur,
            "-ac", "1", "-ar", &sr, "-f", "s16le", "pipe:1",
        ])
        .output()
        .await
        .map_err(|e| AppError::Sidecar(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Probe(format!(
            "ffmpeg decode exit {:?}: {}",
            output.status.code(),
            stderr.trim()
        )));
    }

    Ok(output
        .stdout
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect())
}

/// Detects the tempo of mono PCM samples, or `None` when the signal carries no
/// convincing periodic pulse (silence, noise, spoken word, too short). Pure.
pub fn detect_bpm(samples: &[i16], sample_rate: u32) -> Option<u32> {
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

    Some(fold_to_preferred(bpm, &acf, env_rate).round() as u32)
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

/// Folds a tempo into [`PREFERRED_MIN`, `PREFERRED_MAX`] by halving/doubling.
/// Half/double-time is the dominant error mode of every autocorrelation tempo
/// estimator, and the autocorrelation alone cannot break the tie: an isochronous
/// pulse peaks equally at every multiple of its period.
///
/// The tie-breaker is asymmetric. A track really at 174 BPM also correlates at
/// 87, but a track really at 87 has *no* peak at 174 — there are no events
/// there. So among the octaves that still explain the signal (within
/// [`OCTAVE_TOLERANCE`] of the best), the fastest one is the fundamental.
fn fold_to_preferred(bpm: f32, acf: &[f32], env_rate: f32) -> f32 {
    let score = |c: f32| {
        let lag = (env_rate * 60.0 / c).round() as usize;
        acf.get(lag).copied().unwrap_or(f32::MIN)
    };
    // The margin matters: without it an estimate of 69.84 falls just outside the
    // band and gets pushed to 139.7, an octave away from the right answer.
    let mut candidates: Vec<f32> = [0.25, 0.5, 1.0, 2.0, 4.0]
        .iter()
        .map(|f| bpm * f)
        .filter(|c| *c >= PREFERRED_MIN - BAND_MARGIN && *c <= PREFERRED_MAX + BAND_MARGIN)
        .collect();

    let best = candidates.iter().fold(f32::MIN, |m, c| m.max(score(*c)));
    if candidates.is_empty() || best <= 0.0 {
        // No octave lands in the band, or none explains the signal — keep the
        // raw estimate rather than inventing one.
        return bpm;
    }
    let floor = best * OCTAVE_TOLERANCE;
    // The best-scoring candidate always clears the floor, so this is non-empty.
    candidates.retain(|c| score(*c) >= floor);
    candidates.into_iter().fold(f32::MIN, f32::max)
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
            let diff = (got as f32 - bpm).abs();
            assert!(diff <= 1.0, "expected ~{bpm}, got {got}");
        }
    }

    #[test]
    fn keeps_downtempo_instead_of_reporting_double_time() {
        // Strong beat, weak off-beat: the 70 BPM period correlates better than
        // the 140 BPM one, so octave folding must not push this to 140.
        let samples = click_track(70.0, 40.0, 0.35);
        let got = detect_bpm(&samples, SR).expect("no BPM detected");
        assert!((got as f32 - 70.0).abs() <= 1.0, "expected ~70, got {got}");
    }

    #[test]
    fn folds_out_of_range_tempo_into_the_preferred_band() {
        // 300 BPM is above the search range; its 150 BPM subharmonic is the
        // musically sensible answer.
        let samples = click_track(300.0, 30.0, 1.0);
        let got = detect_bpm(&samples, SR).expect("no BPM detected");
        assert!(
            (got as f32) >= PREFERRED_MIN && (got as f32) <= PREFERRED_MAX,
            "{got} outside the preferred band"
        );
        assert!((got as f32 - 150.0).abs() <= 1.0, "expected ~150, got {got}");
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
