use rusty_chromaprint::{Configuration, Fingerprinter};
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::error::{AppError, AppResult};

/// Länge (Sekunden), die pro Datei für den Fingerabdruck dekodiert wird.
/// Reicht, um denselben Track zuverlässig zu erkennen, ohne ganze Files zu lesen.
const FINGERPRINT_SECS: u32 = 120;

/// Sample-Rate, auf die chromaprint intern ohnehin resampled.
const SAMPLE_RATE: u32 = 11025;

/// Gemeinsame Konfiguration für Berechnung und Vergleich.
pub fn config() -> Configuration {
    Configuration::default()
}

/// Dekodiert den Anfang einer Datei zu Mono-PCM (11025 Hz, s16le) via ffmpeg
/// und berechnet daraus einen Chromaprint-Fingerabdruck. Format-/Dateinamen-
/// unabhängig, da auf dem tatsächlichen Audioinhalt basierend.
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

    // Rohe s16le-Bytes -> i16-Samples.
    let samples: Vec<i16> = output
        .stdout
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect();

    if samples.is_empty() {
        return Err(AppError::Probe("kein Audio dekodiert".into()));
    }

    let mut printer = Fingerprinter::new(&config());
    printer
        .start(SAMPLE_RATE, 1)
        .map_err(|e| AppError::Probe(format!("Fingerprint-Start fehlgeschlagen: {e}")))?;
    printer.consume(&samples);
    printer.finish();
    Ok(printer.fingerprint().to_vec())
}
