//! One pass over a file, three answers.
//!
//! Tempo, key and waveform all start from the same decoded PCM, and decoding is
//! what the pass actually costs: roughly 300 ms against 30 ms of tempo detection
//! and 40 ms of key detection. Running them separately would have tripled the
//! time a scan takes for values that come out of the same audio.
//!
//! It lives in its own module rather than in `bpm`, where it began, because a
//! function that answers three questions does not belong to one of them.

use tauri::AppHandle;

use super::{beats, bpm, decode, key, waveform};
use crate::error::{AppError, AppResult};

/// Sample rate the whole analysis works at.
const SAMPLE_RATE: u32 = 11025;

/// The excerpt tempo and key are detected from: 120 s starting 30 s in, so an
/// ambient intro does not decide either. Sliced out of the full decode rather
/// than decoded separately.
const EXCERPT_SECS: u32 = 120;
const EXCERPT_OFFSET_SECS: u32 = 30;

/// What the pass found. Every field is optional on its own: a track may carry a
/// tempo but no clear key, or a waveform but no pulse to place beats on.
#[derive(Debug, Clone, Default)]
pub struct Analysis {
    pub tempo: Option<bpm::Tempo>,
    pub key: Option<key::DetectedKey>,
    pub beats: Option<beats::BeatGrid>,
    pub waveform: Option<waveform::Waveform>,
}

/// What a caller still needs. A file whose tempo is tagged and whose waveform is
/// cached needs neither computed again, and the pass then skips straight past
/// the work rather than being called and throwing the result away.
#[derive(Debug, Clone, Copy)]
pub struct Wanted {
    pub tempo: bool,
    pub key: bool,
    pub waveform: bool,
}

impl Wanted {
    fn nothing(&self) -> bool {
        !self.tempo && !self.key && !self.waveform
    }
}

/// Decodes a file once and runs whichever detectors are wanted.
pub async fn analyze(
    app: &AppHandle,
    path: &str,
    config: bpm::TempoConfig,
    wanted: Wanted,
) -> AppResult<Analysis> {
    if wanted.nothing() {
        return Ok(Analysis::default());
    }
    // The whole file: the waveform has to cover the whole track, and the
    // excerpt the other two want is a slice of it. `secs = 0` reads to the end.
    let samples = decode::mono_pcm(app, path, SAMPLE_RATE, 0, 0).await?;
    if samples.is_empty() {
        return Err(AppError::Probe("no audio decoded".into()));
    }

    // Detection is seconds of CPU work. Running it on an async worker thread
    // would block the runtime the concurrent decodes share — with one task per
    // core, throughput collapses.
    tauri::async_runtime::spawn_blocking(move || {
        let excerpt = excerpt_of(&samples, SAMPLE_RATE);
        let tempo = wanted
            .tempo
            .then(|| bpm::detect_bpm_with(excerpt, SAMPLE_RATE, config))
            .flatten();
        Analysis {
            tempo,
            key: wanted
                .key
                .then(|| key::detect_key(excerpt, SAMPLE_RATE))
                .flatten(),
            // Beats need a tempo to have a phase at all, so they come free with
            // one and are skipped without.
            beats: tempo
                .and_then(|t| beats::detect_beats(excerpt, SAMPLE_RATE, t.bpm)),
            waveform: wanted
                .waveform
                .then(|| waveform::reduce(&samples, waveform::BINS)),
        }
    })
    .await
    .map_err(|e| AppError::Probe(format!("Analysis task failed: {e}")))
}

/// The window tempo and key are detected from, as a slice of the full decode.
///
/// Falls back to the start for a track shorter than the offset, and to the whole
/// thing for one shorter than the window — the same rule the separate decoders
/// had, kept because the B7 baseline was measured with it.
fn excerpt_of(samples: &[i16], sample_rate: u32) -> &[i16] {
    let start = (EXCERPT_OFFSET_SECS * sample_rate) as usize;
    let len = (EXCERPT_SECS * sample_rate) as usize;
    // Ten seconds is the least worth analysing; below that, use the start.
    let usable = samples.len().saturating_sub(start) >= (sample_rate * 10) as usize;
    let from = if usable { start } else { 0 };
    &samples[from..(from + len).min(samples.len())]
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: u32 = SAMPLE_RATE;

    #[test]
    fn the_excerpt_starts_after_the_intro() {
        // A long track: 120 s from 0:30, which is what every tempo number in
        // docs/DSP_BENCHMARK.md was measured against.
        let samples = vec![0i16; SR as usize * 300];
        let excerpt = excerpt_of(&samples, SR);
        assert_eq!(excerpt.len(), SR as usize * 120);
        // Same slice the old separate decode produced.
        let start = SR as usize * 30;
        assert_eq!(excerpt.as_ptr(), samples[start..].as_ptr());
    }

    #[test]
    fn a_short_track_is_analysed_from_the_start() {
        // 35 s: skipping 30 would leave 5 s, less than the 10 s minimum, so the
        // whole thing is used instead of a stub.
        let samples = vec![0i16; SR as usize * 35];
        let excerpt = excerpt_of(&samples, SR);
        assert_eq!(excerpt.len(), samples.len());
        assert_eq!(excerpt.as_ptr(), samples.as_ptr());
    }

    #[test]
    fn a_track_just_long_enough_keeps_the_offset() {
        // 40 s leaves exactly 10 s after the offset — the boundary case.
        let samples = vec![0i16; SR as usize * 40];
        let excerpt = excerpt_of(&samples, SR);
        assert_eq!(excerpt.len(), SR as usize * 10);
    }

    #[test]
    fn the_excerpt_never_runs_past_the_audio() {
        for secs in [1u32, 9, 10, 31, 100, 149, 151] {
            let samples = vec![0i16; SR as usize * secs as usize];
            let excerpt = excerpt_of(&samples, SR);
            assert!(
                excerpt.len() <= samples.len(),
                "{secs}s track produced {} samples",
                excerpt.len()
            );
            assert!(!excerpt.is_empty() || samples.is_empty());
        }
    }

    #[test]
    fn wanting_nothing_is_a_recognised_state() {
        // The pass is called per track, and a file with everything cached must
        // cost nothing rather than a decode.
        assert!(Wanted { tempo: false, key: false, waveform: false }.nothing());
        assert!(!Wanted { tempo: false, key: false, waveform: true }.nothing());
    }
}
