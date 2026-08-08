//! Decoding audio to raw PCM through the bundled ffmpeg sidecar.
//!
//! This exists because piping **binary** data out of the shell plugin is a trap:
//! `Command::output()` reads the child's stdout line by line and re-appends a
//! newline after every chunk (`tauri-plugin-shell`, `process/mod.rs`), which
//! shifts the 16-bit sample alignment and turns PCM into noise. The fix is
//! `set_raw_out(true)` **and** consuming the events ourselves — `output()`
//! appends the newline regardless of that flag.

use tauri::AppHandle;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::error::{AppError, AppResult};

/// Decodes `secs` seconds starting at `offset_secs` as mono `s16le` and returns
/// the samples. `secs = 0` decodes to the end of the file.
pub async fn mono_pcm(
    app: &AppHandle,
    path: &str,
    sample_rate: u32,
    offset_secs: u32,
    secs: u32,
) -> AppResult<Vec<i16>> {
    let offset = offset_secs.to_string();
    let duration = secs.to_string();
    let rate = sample_rate.to_string();

    let mut args = vec!["-v", "error"];
    if offset_secs > 0 {
        args.extend(["-ss", &offset]);
    }
    args.extend(["-i", path, "-map", "0:a:0"]);
    if secs > 0 {
        args.extend(["-t", &duration]);
    }
    args.extend(["-ac", "1", "-ar", &rate, "-f", "s16le", "pipe:1"]);

    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| AppError::Sidecar(e.to_string()))?
        .args(args)
        // Without this the reader splits on newlines and mangles the stream.
        .set_raw_out(true)
        .spawn()
        .map_err(|e| AppError::Sidecar(e.to_string()))?;

    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();
    let mut code = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(chunk) => stdout.extend(chunk),
            CommandEvent::Stderr(chunk) => stderr.extend(chunk),
            CommandEvent::Terminated(payload) => code = payload.code,
            _ => {}
        }
    }

    if code != Some(0) {
        return Err(AppError::Probe(format!(
            "ffmpeg decode exit {code:?}: {}",
            String::from_utf8_lossy(&stderr).trim()
        )));
    }

    Ok(to_samples(&stdout))
}

/// Little-endian `s16` bytes to samples. A trailing odd byte is dropped.
pub fn to_samples(bytes: &[u8]) -> Vec<i16> {
    bytes
        .chunks_exact(2)
        .map(|c| i16::from_le_bytes([c[0], c[1]]))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::to_samples;

    #[test]
    fn converts_little_endian_pairs() {
        // 0x0100 = 1, 0xFFFF = -1, 0x0080 = i16::MIN
        assert_eq!(
            to_samples(&[0x01, 0x00, 0xFF, 0xFF, 0x00, 0x80]),
            vec![1, -1, i16::MIN]
        );
    }

    #[test]
    fn ignores_a_trailing_odd_byte() {
        assert_eq!(to_samples(&[0x01, 0x00, 0x7F]), vec![1]);
        assert_eq!(to_samples(&[]), Vec::<i16>::new());
    }
}
