use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::audio::probe;
use crate::error::{AppError, AppResult};
use crate::models::{ConvertOptions, TargetFormat};

/// Progress event sent to the frontend during conversion.
#[derive(Debug, Clone, Serialize)]
pub struct ConvertProgress {
    pub id: String,
    /// 0..=100
    pub percent: u32,
    pub stage: String,
}

/// Derive a target sample rate supported by all players.
fn target_sample_rate(source_rate: u32) -> u32 {
    match source_rate {
        44_100 | 48_000 => source_rate,
        _ => 44_100,
    }
}

/// Replaces characters problematic for CDJ/USB with underscores.
fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect::<String>()
        .trim()
        .to_string()
}

/// Determines the output path for a source file and a target format.
fn output_path(source: &str, opts: &ConvertOptions) -> AppResult<PathBuf> {
    let src = Path::new(source);
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Convert(format!("invalid file name: {source}")))?;

    let stem = if opts.sanitize_filenames {
        sanitize(stem)
    } else {
        stem.to_string()
    };

    let file_name = format!("{stem}.{}", opts.format.extension());

    let dir = match &opts.output_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => src
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(".")),
    };

    Ok(dir.join(file_name))
}

/// Builds the ffmpeg argument list for source -> target.
fn build_args(source: &str, output: &str, opts: &ConvertOptions, source_rate: u32) -> Vec<String> {
    let sr = target_sample_rate(source_rate).to_string();
    let bit24 = opts.bit_depth == 24;

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        source.into(),
        // Take only the first audio stream (cover art follows in phase 2 via lofty).
        "-map".into(),
        "0:a:0".into(),
        // Carry over existing text metadata.
        "-map_metadata".into(),
        "0".into(),
    ];

    match opts.format {
        TargetFormat::Aiff => {
            args.push("-c:a".into());
            args.push(if bit24 { "pcm_s24be" } else { "pcm_s16be" }.into());
            args.push("-write_id3v2".into());
            args.push("1".into());
        }
        TargetFormat::Wav => {
            args.push("-c:a".into());
            args.push(if bit24 { "pcm_s24le" } else { "pcm_s16le" }.into());
        }
        TargetFormat::Flac => {
            args.push("-c:a".into());
            args.push("flac".into());
            args.push("-sample_fmt".into());
            args.push(if bit24 { "s32" } else { "s16" }.into());
        }
        TargetFormat::Alac => {
            args.push("-c:a".into());
            args.push("alac".into());
            args.push("-sample_fmt".into());
            args.push(if bit24 { "s32p" } else { "s16p" }.into());
        }
        TargetFormat::Mp3 => {
            args.push("-c:a".into());
            args.push("libmp3lame".into());
            args.push("-b:a".into());
            args.push("320k".into());
        }
        TargetFormat::Aac => {
            args.push("-c:a".into());
            args.push("aac".into());
            args.push("-b:a".into());
            args.push("320k".into());
        }
    }

    args.push("-ar".into());
    args.push(sr);

    // Emit machine-readable progress on stdout.
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());

    args.push(output.into());
    args
}

/// Result of a conversion.
pub struct Converted {
    /// Final target path.
    pub output_path: String,
    /// Path where the converted bytes currently reside. For an in-place
    /// conversion (temp file) this differs from `output_path`; the caller
    /// must then move `written_path` -> `output_path` after finalizing.
    pub written_path: String,
}

/// Converts a single file and streams progress via events.
pub async fn convert_file(
    app: &AppHandle,
    id: &str,
    source: &str,
    opts: &ConvertOptions,
) -> AppResult<Converted> {
    // Analyze first for the target sample rate and progress calculation.
    let info = probe::probe(app, source).await?;
    let out = output_path(source, opts)?;
    let out_str = out.to_string_lossy().to_string();

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    // An in-place conversion (target == source) would have ffmpeg overwrite the
    // file it is currently reading. So write to a temp file and replace afterwards.
    let in_place = paths_equal(source, &out);
    let write_target = if in_place {
        temp_sibling(&out)
    } else {
        out.clone()
    };
    let write_str = write_target.to_string_lossy().to_string();

    let args = build_args(source, &write_str, opts, info.sample_rate);
    let total_us = (info.duration_secs * 1_000_000.0).max(1.0);

    let (mut rx, _child) = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| AppError::Sidecar(e.to_string()))?
        .args(args)
        .spawn()
        .map_err(|e| AppError::Sidecar(e.to_string()))?;

    emit_progress(app, id, 0, "Start");

    let mut stderr_tail = String::new();
    let mut exit_code: Option<i32> = None;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes);
                if let Some(pct) = parse_progress(&line, total_us) {
                    emit_progress(app, id, pct, "Converting");
                }
            }
            CommandEvent::Stderr(bytes) => {
                // Collect the last ffmpeg output for error messages.
                let line = String::from_utf8_lossy(&bytes);
                stderr_tail.push_str(&line);
                if stderr_tail.len() > 4000 {
                    let cut = stderr_tail.len() - 4000;
                    stderr_tail = stderr_tail.split_off(cut);
                }
            }
            CommandEvent::Terminated(payload) => {
                exit_code = payload.code;
            }
            _ => {}
        }
    }

    match exit_code {
        Some(0) => {
            emit_progress(app, id, 100, "Done");
            Ok(Converted {
                output_path: out_str,
                written_path: write_str,
            })
        }
        other => {
            if in_place {
                let _ = std::fs::remove_file(&write_target);
            }
            Err(AppError::Convert(format!(
                "ffmpeg exit {:?}: {}",
                other,
                stderr_tail.trim()
            )))
        }
    }
}

/// Checks whether two paths point to the same file.
fn paths_equal(a: &str, b: &Path) -> bool {
    let pa = Path::new(a);
    if pa == b {
        return true;
    }
    match (pa.canonicalize(), b.canonicalize()) {
        (Ok(ca), Ok(cb)) => ca == cb,
        _ => false,
    }
}

/// Returns a free temp path next to the target (same extension for ffmpeg).
fn temp_sibling(target: &Path) -> PathBuf {
    let ext = target
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("tmp");
    let stem = target
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("output");
    let dir = target.parent().unwrap_or_else(|| Path::new("."));
    for i in 0.. {
        let candidate = dir.join(format!("{stem}.rekordtmp{i}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Parses an ffmpeg progress line and computes the percentage.
fn parse_progress(chunk: &str, total_us: f64) -> Option<u32> {
    // ffmpeg emits blocks of key=value lines; out_time_us is the decisive one.
    let mut latest: Option<u32> = None;
    for line in chunk.lines() {
        if let Some(val) = line.strip_prefix("out_time_us=") {
            if let Ok(us) = val.trim().parse::<f64>() {
                let pct = ((us / total_us) * 100.0).clamp(0.0, 99.0) as u32;
                latest = Some(pct);
            }
        } else if line.trim() == "progress=end" {
            latest = Some(99);
        }
    }
    latest
}

fn emit_progress(app: &AppHandle, id: &str, percent: u32, stage: &str) {
    let _ = app.emit(
        "convert://progress",
        ConvertProgress {
            id: id.to_string(),
            percent,
            stage: stage.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(format: TargetFormat, bit_depth: u32, output_dir: Option<&str>, sanitize: bool) -> ConvertOptions {
        ConvertOptions {
            format,
            bit_depth,
            output_dir: output_dir.map(str::to_string),
            sanitize_filenames: sanitize,
            replace_source: false,
        }
    }

    #[test]
    fn target_sample_rate_keeps_supported_and_falls_back() {
        assert_eq!(target_sample_rate(44_100), 44_100);
        assert_eq!(target_sample_rate(48_000), 48_000);
        assert_eq!(target_sample_rate(96_000), 44_100);
        assert_eq!(target_sample_rate(22_050), 44_100);
    }

    #[test]
    fn sanitize_replaces_problem_chars() {
        assert_eq!(sanitize("a/b:c*?\"<>|"), "a_b_c______");
        assert_eq!(sanitize("  clean name  "), "clean name");
    }

    #[test]
    fn output_path_uses_output_dir_and_extension() {
        let p = output_path("/music/song.wav", &opts(TargetFormat::Aiff, 16, Some("/out"), false)).unwrap();
        assert_eq!(p, PathBuf::from("/out/song.aiff"));
    }

    #[test]
    fn output_path_defaults_next_to_source() {
        let p = output_path("/music/sub/song.flac", &opts(TargetFormat::Mp3, 16, None, false)).unwrap();
        assert_eq!(p, PathBuf::from("/music/sub/song.mp3"));
    }

    #[test]
    fn output_path_sanitizes_stem_when_requested() {
        let p = output_path("/music/a:b?.wav", &opts(TargetFormat::Wav, 16, None, true)).unwrap();
        assert_eq!(p.file_name().unwrap().to_str().unwrap(), "a_b_.wav");
    }

    #[test]
    fn build_args_carries_metadata_and_first_audio_stream() {
        let args = build_args("in.wav", "out.aiff", &opts(TargetFormat::Aiff, 24, None, false), 44_100);
        assert!(args.windows(2).any(|w| w == ["-map", "0:a:0"]));
        assert!(args.windows(2).any(|w| w == ["-map_metadata", "0"]));
        assert!(args.windows(2).any(|w| w == ["-ar", "44100"]));
        assert_eq!(args.last().unwrap(), "out.aiff");
    }

    #[test]
    fn build_args_selects_codec_and_bit_depth() {
        let aiff24 = build_args("i", "o", &opts(TargetFormat::Aiff, 24, None, false), 44_100);
        assert!(aiff24.iter().any(|a| a == "pcm_s24be"));
        let aiff16 = build_args("i", "o", &opts(TargetFormat::Aiff, 16, None, false), 44_100);
        assert!(aiff16.iter().any(|a| a == "pcm_s16be"));
        let mp3 = build_args("i", "o", &opts(TargetFormat::Mp3, 16, None, false), 48_000);
        assert!(mp3.windows(2).any(|w| w == ["-c:a", "libmp3lame"]));
        assert!(mp3.windows(2).any(|w| w == ["-b:a", "320k"]));
        // Unsupported source rate must be downsampled to 44.1 kHz.
        assert!(mp3.windows(2).any(|w| w == ["-ar", "48000"]));
        let odd = build_args("i", "o", &opts(TargetFormat::Flac, 16, None, false), 96_000);
        assert!(odd.windows(2).any(|w| w == ["-ar", "44100"]));
    }

    #[test]
    fn parse_progress_computes_percentage() {
        let total = 100_000_000.0; // 100s
        assert_eq!(parse_progress("out_time_us=50000000\n", total), Some(50));
        // clamped to 99 while running
        assert_eq!(parse_progress("out_time_us=100000000\n", total), Some(99));
        assert_eq!(parse_progress("progress=end\n", total), Some(99));
        assert_eq!(parse_progress("frame=10\nfps=25\n", total), None);
    }

    #[test]
    fn temp_sibling_keeps_extension() {
        let t = temp_sibling(Path::new("/music/song.aiff"));
        assert_eq!(t.extension().and_then(|e| e.to_str()), Some("aiff"));
        assert!(t.file_name().unwrap().to_str().unwrap().starts_with("song.rekordtmp"));
    }

    #[test]
    fn paths_equal_detects_same_path() {
        assert!(paths_equal("/a/b.wav", Path::new("/a/b.wav")));
        assert!(!paths_equal("/a/b.wav", Path::new("/a/c.wav")));
    }
}
