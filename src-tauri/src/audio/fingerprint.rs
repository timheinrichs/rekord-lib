use rusty_chromaprint::{Configuration, Fingerprinter};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

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
    let dur = FINGERPRINT_SECS.to_string();
    let sr = SAMPLE_RATE.to_string();
    let output = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| AppError::Sidecar(e.to_string()))?
        .args([
            "-v", "error", "-i", path, "-map", "0:a:0", "-t", &dur, "-ac", "1",
            "-ar", &sr, "-f", "s16le", "pipe:1",
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

    // Raw s16le bytes -> i16 samples.
    let samples: Vec<i16> = output
        .stdout
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();

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
