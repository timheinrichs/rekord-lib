use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::error::{AppError, AppResult};
use crate::models::AudioInfo;

/// Führt den gebündelten ffprobe-Sidecar aus und liefert die rohen JSON-Daten.
async fn run_ffprobe(app: &AppHandle, path: &str) -> AppResult<Value> {
    let output = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| AppError::Sidecar(e.to_string()))?
        .args([
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .output()
        .await
        .map_err(|e| AppError::Sidecar(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Probe(format!(
            "ffprobe exit {:?}: {}",
            output.status.code(),
            stderr
        )));
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Probe(format!("JSON konnte nicht gelesen werden: {e}")))
}

/// Verlustfreie Codecs, die für die Bit-Tiefen-/Container-Regeln relevant sind.
fn is_lossless_codec(codec: &str) -> bool {
    codec.starts_with("pcm_") || matches!(codec, "flac" | "alac" | "wavpack" | "tta")
}

/// Analysiert eine Datei und extrahiert die relevanten Audio-Eigenschaften.
pub async fn probe(app: &AppHandle, path: &str) -> AppResult<AudioInfo> {
    let json = run_ffprobe(app, path).await?;

    let streams = json
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Probe("keine Streams gefunden".into()))?;

    let audio = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("audio"))
        .ok_or_else(|| AppError::Probe("kein Audio-Stream gefunden".into()))?;

    let codec = audio
        .get("codec_name")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    // sample_rate kommt als String, z. B. "44100".
    let sample_rate = audio
        .get("sample_rate")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    // Bit-Tiefe: bits_per_raw_sample bevorzugt, sonst bits_per_sample.
    let bits_per_sample = audio
        .get("bits_per_raw_sample")
        .and_then(json_number_as_u32)
        .or_else(|| audio.get("bits_per_sample").and_then(json_number_as_u32))
        .unwrap_or(0);

    let channels = audio
        .get("channels")
        .and_then(json_number_as_u32)
        .unwrap_or(0);

    // Dauer: bevorzugt aus dem Stream, sonst aus dem Container.
    let duration_secs = audio
        .get("duration")
        .and_then(json_number_as_f64)
        .or_else(|| {
            json.get("format")
                .and_then(|f| f.get("duration"))
                .and_then(json_number_as_f64)
        })
        .unwrap_or(0.0);

    let container = json
        .get("format")
        .and_then(|f| f.get("format_name"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    Ok(AudioInfo {
        container,
        lossless: is_lossless_codec(&codec),
        codec,
        sample_rate,
        bits_per_sample,
        channels,
        duration_secs,
    })
}

/// ffprobe liefert Zahlen teils als String, teils als Number.
fn json_number_as_u32(v: &Value) -> Option<u32> {
    v.as_u64()
        .map(|n| n as u32)
        .or_else(|| v.as_str().and_then(|s| s.parse::<u32>().ok()))
}

fn json_number_as_f64(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}
