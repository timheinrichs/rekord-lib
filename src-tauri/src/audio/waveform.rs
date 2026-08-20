//! Waveform overview for the player bar.
//!
//! Split like the tempo detector: [`reduce`] is pure and unit-tested, and
//! [`analyze`] only adds the ffmpeg decode. Two values per bin rather than one,
//! because a peak-only waveform is a solid block: the peak outlines the
//! transients and the RMS shows where the energy actually sits, which is what
//! makes an intro distinguishable from a drop at a glance.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::decode;
use crate::error::{AppError, AppResult};

/// Sample rate to decode at. The waveform needs envelope shape, not bandwidth,
/// and this matches the rest of the analysis pipeline — one decoder setting,
/// one thing to reason about.
const SAMPLE_RATE: u32 = 11025;

/// Bins across the whole track.
///
/// A player bar is at most ~1500 px wide, so this is roughly two bins per pixel
/// — enough that the drawing looks the same on a retina display and does not
/// change when the window is resized. Not a per-request parameter: making it one
/// would mean a different result for every window width.
pub const BINS: usize = 2400;

/// One track's overview: `peak` and `rms` per bin, both `0.0..=1.0`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Waveform {
    pub peak: Vec<f32>,
    pub rms: Vec<f32>,
}

impl Waveform {
    fn empty() -> Self {
        Self {
            peak: Vec::new(),
            rms: Vec::new(),
        }
    }
}

/// Decodes a whole file to mono PCM and reduces it to [`BINS`] bins.
pub async fn analyze(app: &AppHandle, path: &str) -> AppResult<Waveform> {
    // `secs = 0` decodes to the end: a waveform of the first two minutes would
    // be worse than none, because the bar would lie about where you are.
    let samples = decode::mono_pcm(app, path, SAMPLE_RATE, 0, 0).await?;
    if samples.is_empty() {
        return Err(AppError::Probe("no audio decoded".into()));
    }
    // Reduction over millions of samples is CPU work, so it goes off the async
    // runtime for the same reason tempo detection does.
    tauri::async_runtime::spawn_blocking(move || reduce(&samples, BINS))
        .await
        .map_err(|e| AppError::Probe(format!("Waveform task failed: {e}")))
}

/// Reduces samples to `bins` peak/RMS pairs, normalised so the loudest bin's
/// peak is 1.0.
///
/// Normalised rather than absolute: the bar is drawn at a fixed height, so what
/// matters is the shape within the track. A quiet master would otherwise render
/// as a flat line and look broken.
pub fn reduce(samples: &[i16], bins: usize) -> Waveform {
    if samples.is_empty() || bins == 0 {
        return Waveform::empty();
    }
    // Fewer samples than bins: one bin each, rather than empty bins that would
    // draw as gaps in the middle of the waveform.
    let bins = bins.min(samples.len());

    let mut peak = Vec::with_capacity(bins);
    let mut rms = Vec::with_capacity(bins);
    for bin in 0..bins {
        // Boundaries from the bin index, so rounding cannot leave a gap or read
        // past the end on the last bin.
        let start = samples.len() * bin / bins;
        let end = (samples.len() * (bin + 1) / bins).max(start + 1);
        let slice = &samples[start..end.min(samples.len())];

        let mut max = 0.0f32;
        let mut sum_sq = 0.0f64;
        for s in slice {
            // i16::MIN negated overflows, which is why this divides before
            // taking the magnitude.
            let v = *s as f32 / 32768.0;
            max = max.max(v.abs());
            sum_sq += (v as f64) * (v as f64);
        }
        peak.push(max);
        rms.push((sum_sq / slice.len() as f64).sqrt() as f32);
    }

    // Normalise both by the loudest peak, so their relationship survives.
    let loudest = peak.iter().copied().fold(0.0f32, f32::max);
    if loudest > 0.0 {
        for v in peak.iter_mut().chain(rms.iter_mut()) {
            *v = (*v / loudest).min(1.0);
        }
    }
    Waveform { peak, rms }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A ramp from silence to full scale, so every bin differs from the next.
    fn ramp(len: usize) -> Vec<i16> {
        (0..len)
            .map(|i| ((i as f32 / len as f32) * 32000.0) as i16)
            .collect()
    }

    #[test]
    fn produces_the_requested_number_of_bins() {
        let w = reduce(&ramp(100_000), 2400);
        assert_eq!(w.peak.len(), 2400);
        assert_eq!(w.rms.len(), 2400);
    }

    #[test]
    fn covers_the_whole_track_without_gaps() {
        // A bin computed from a rounded step size would either leave the tail
        // unread or run past the end; the ramp makes that visible because the
        // last bin has to be the loudest.
        let w = reduce(&ramp(10_000), 100);
        assert!(w.peak[99] > w.peak[0], "the ramp's end must be the loudest");
        for (i, v) in w.peak.iter().enumerate() {
            assert!(*v > 0.0 || i == 0, "bin {i} was never filled");
        }
        // Monotonic, since the input is.
        for pair in w.peak.windows(2) {
            assert!(pair[1] >= pair[0], "the ramp came back non-monotonic");
        }
    }

    #[test]
    fn normalises_the_loudest_bin_to_one() {
        // A quiet master has to fill the bar too, otherwise it draws as a flat
        // line and looks like a broken file.
        let quiet: Vec<i16> = ramp(10_000).iter().map(|s| s / 20).collect();
        let loud = reduce(&ramp(10_000), 50);
        let soft = reduce(&quiet, 50);
        assert!((loud.peak.iter().copied().fold(0.0, f32::max) - 1.0).abs() < 1e-6);
        assert!((soft.peak.iter().copied().fold(0.0, f32::max) - 1.0).abs() < 1e-6);
        // And the shape is the same either way.
        for (a, b) in loud.peak.iter().zip(&soft.peak) {
            assert!((a - b).abs() < 0.05, "{a} vs {b}");
        }
    }

    #[test]
    fn rms_sits_below_the_peak() {
        // What makes the two-tone drawing readable. For a sine the ratio is
        // 1/sqrt(2); anything above the peak would be a bug in the maths.
        let sine: Vec<i16> = (0..44_100)
            .map(|i| {
                let t = i as f32 / 11_025.0;
                ((2.0 * std::f32::consts::PI * 220.0 * t).sin() * 30_000.0) as i16
            })
            .collect();
        let w = reduce(&sine, 40);
        for (peak, rms) in w.peak.iter().zip(&w.rms) {
            assert!(rms <= peak, "rms {rms} above peak {peak}");
            assert!(*rms > peak * 0.5, "rms {rms} implausibly low for a sine");
        }
    }

    #[test]
    fn silence_stays_silent_instead_of_being_normalised_up() {
        // Dividing by the loudest bin would be a division by zero here, and
        // "normalise silence" has no meaning — it must stay flat.
        let w = reduce(&vec![0i16; 10_000], 50);
        assert_eq!(w.peak.len(), 50);
        assert!(w.peak.iter().all(|v| *v == 0.0));
        assert!(w.rms.iter().all(|v| *v == 0.0));
    }

    #[test]
    fn handles_less_audio_than_bins() {
        // A three-second file asked for 2400 bins: one bin per sample rather
        // than empty bins, which would draw as holes.
        let w = reduce(&ramp(10), 2400);
        assert_eq!(w.peak.len(), 10);
        assert_eq!(w.rms.len(), 10);
    }

    #[test]
    fn empty_input_is_empty_output() {
        assert_eq!(reduce(&[], 2400), Waveform::empty());
        assert_eq!(reduce(&ramp(100), 0), Waveform::empty());
    }

    #[test]
    fn survives_the_extremes_of_the_sample_range() {
        // i16::MIN has no positive counterpart; taking its magnitude before
        // scaling would overflow.
        let w = reduce(&[i16::MIN, i16::MAX, i16::MIN, i16::MAX], 2);
        assert!(w.peak.iter().all(|v| v.is_finite() && *v <= 1.0));
        assert!(w.rms.iter().all(|v| v.is_finite() && *v <= 1.0));
    }
}
