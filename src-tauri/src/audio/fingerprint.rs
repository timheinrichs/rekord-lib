use rusty_chromaprint::{Configuration, Fingerprinter};
use tauri::AppHandle;

use super::decode;
use crate::error::{AppError, AppResult};

/// Length (seconds) decoded per file for the fingerprint.
/// Enough to reliably identify the same track without reading whole files.
const FINGERPRINT_SECS: u32 = 120;

/// Sample rate that chromaprint resamples to internally anyway.
const SAMPLE_RATE: u32 = 11025;

/// Shared configuration for computation and comparison.
pub fn config() -> Configuration {
    Configuration::default()
}

/// Decodes the beginning of a file to mono PCM (11025 Hz, s16le) via ffmpeg
/// and computes a Chromaprint fingerprint from it. Independent of format/file
/// name, since it is based on the actual audio content.
pub async fn fingerprint(app: &AppHandle, path: &str) -> AppResult<Vec<u32>> {
    let samples = decode::mono_pcm(app, path, SAMPLE_RATE, 0, FINGERPRINT_SECS).await?;

    if samples.is_empty() {
        return Err(AppError::Probe("no audio decoded".into()));
    }

    let mut printer = Fingerprinter::new(&config());
    printer
        .start(SAMPLE_RATE, 1)
        .map_err(|e| AppError::Probe(format!("Fingerprint start failed: {e}")))?;
    printer.consume(&samples);
    printer.finish();
    Ok(printer.fingerprint().to_vec())
}
