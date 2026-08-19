use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_shell::ShellExt;

use crate::error::{AppError, AppResult};
use crate::models::AudioInfo;

/// Runs the bundled ffprobe sidecar and returns the raw JSON data.
async fn run_ffprobe(app: &AppHandle, path: &str) -> AppResult<Value> {
    let output = app
        .shell()
        .sidecar("ffprobe")
        .map_err(|e| AppError::Sidecar(e.to_string()))?
        .args([
            // `error`, not `quiet`: the exit code alone says nothing, and this
            // is the only place that learns *why* a file cannot be used. The
            // JSON goes to stdout, diagnostics to stderr, so the output stays
            // parseable either way.
            "-v",
            "error",
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
        return Err(AppError::Probe(probe_error(
            path,
            output.status.code(),
            &stderr,
        )));
    }

    serde_json::from_slice(&output.stdout)
        .map_err(|e| AppError::Probe(format!("JSON could not be read: {e}")))
}

/// Lossless codecs relevant to the bit-depth/container rules.
fn is_lossless_codec(codec: &str) -> bool {
    codec.starts_with("pcm_") || matches!(codec, "flac" | "alac" | "wavpack" | "tta")
}

/// Analyzes a file and extracts the relevant audio properties.
/// Why a probe failed, as a line that is worth putting in front of the user.
///
/// ffprobe explains itself on stderr ("Invalid data found when processing
/// input"); the exit code is only useful when it says nothing at all — and a
/// raw `Option<i32>` must never reach the UI as `Some(1)`.
fn probe_error(path: &str, code: Option<i32>, stderr: &str) -> String {
    // The last line carries the diagnosis: anything before it is context for a
    // failure that ffprobe then summarises. The full text is one `Copy` away in
    // the skipped-files list, so nothing is lost by keeping this to one line.
    let last = stderr
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .next_back();
    if let Some(line) = last {
        // ffprobe prefixes the file it was given; whatever shows this already
        // names the file.
        return line
            .strip_prefix(&format!("{path}: "))
            .unwrap_or(line)
            .to_string();
    }
    match code {
        Some(code) => format!("ffprobe failed with exit code {code}"),
        None => "ffprobe was stopped before it finished".to_string(),
    }
}

pub async fn probe(app: &AppHandle, path: &str) -> AppResult<AudioInfo> {
    let json = run_ffprobe(app, path).await?;

    let streams = json
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::Probe("no streams found".into()))?;

    let audio = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(Value::as_str) == Some("audio"))
        .ok_or_else(|| AppError::Probe("no audio stream found".into()))?;

    let codec = audio
        .get("codec_name")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();

    // sample_rate comes as a string, e.g. "44100".
    let sample_rate = audio
        .get("sample_rate")
        .and_then(Value::as_str)
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);

    // Bit depth: prefer bits_per_raw_sample, otherwise bits_per_sample.
    let bits_per_sample = audio
        .get("bits_per_raw_sample")
        .and_then(json_number_as_u32)
        .or_else(|| audio.get("bits_per_sample").and_then(json_number_as_u32))
        .unwrap_or(0);

    let channels = audio
        .get("channels")
        .and_then(json_number_as_u32)
        .unwrap_or(0);

    // Duration: preferably from the stream, otherwise from the container.
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

/// ffprobe returns numbers partly as strings, partly as numbers.
fn json_number_as_u32(v: &Value) -> Option<u32> {
    v.as_u64()
        .map(|n| n as u32)
        .or_else(|| v.as_str().and_then(|s| s.parse::<u32>().ok()))
}

fn json_number_as_f64(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_error_reports_what_ffprobe_said() {
        let path = "/lib/broken.aiff";
        // The real shape: ffprobe names the file, then the diagnosis.
        assert_eq!(
            probe_error(
                path,
                Some(1),
                "/lib/broken.aiff: Invalid data found when processing input\n"
            ),
            "Invalid data found when processing input"
        );
        // A different file in the message is not ours to strip.
        assert_eq!(
            probe_error(path, Some(1), "/other.aiff: Invalid data"),
            "/other.aiff: Invalid data"
        );
    }

    #[test]
    fn probe_error_keeps_the_summary_line() {
        assert_eq!(
            probe_error(
                "/lib/a.aiff",
                Some(1),
                "[aiff @ 0x1] header missing\n/lib/a.aiff: Invalid data found\n\n"
            ),
            "Invalid data found"
        );
    }

    #[test]
    fn probe_error_falls_back_to_the_exit_status() {
        // Nothing on stderr — then the code is all there is, and it must not
        // reach the UI as a Debug-printed Option.
        assert_eq!(
            probe_error("/lib/a.aiff", Some(1), "   \n"),
            "ffprobe failed with exit code 1"
        );
        assert_eq!(
            probe_error("/lib/a.aiff", None, ""),
            "ffprobe was stopped before it finished"
        );
    }
}
