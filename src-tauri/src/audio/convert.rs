use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

use crate::audio::probe;
use crate::error::{AppError, AppResult};
use crate::models::{ConvertOptions, TargetFormat};

/// Fortschritts-Event, das während der Konvertierung an das Frontend geht.
#[derive(Debug, Clone, Serialize)]
pub struct ConvertProgress {
    pub id: String,
    /// 0..=100
    pub percent: u32,
    pub stage: String,
}

/// Auf allen Playern unterstützte Ziel-Samplerate ableiten.
fn target_sample_rate(source_rate: u32) -> u32 {
    match source_rate {
        44_100 | 48_000 => source_rate,
        _ => 44_100,
    }
}

/// Ersetzt für CDJ/USB problematische Zeichen durch Unterstriche.
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

/// Ermittelt den Ausgabepfad für eine Quelldatei und ein Zielformat.
fn output_path(source: &str, opts: &ConvertOptions) -> AppResult<PathBuf> {
    let src = Path::new(source);
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Convert(format!("ungültiger Dateiname: {source}")))?;

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

/// Baut die ffmpeg-Argumentliste für Quelle → Ziel.
fn build_args(source: &str, output: &str, opts: &ConvertOptions, source_rate: u32) -> Vec<String> {
    let sr = target_sample_rate(source_rate).to_string();
    let bit24 = opts.bit_depth == 24;

    let mut args: Vec<String> = vec![
        "-y".into(),
        "-i".into(),
        source.into(),
        // Nur den ersten Audiostream übernehmen (Cover-Art folgt in Phase 2 via lofty).
        "-map".into(),
        "0:a:0".into(),
        // Vorhandene Textmetadaten mitnehmen.
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

    // Maschinenlesbaren Fortschritt auf stdout ausgeben.
    args.push("-progress".into());
    args.push("pipe:1".into());
    args.push("-nostats".into());

    args.push(output.into());
    args
}

/// Ergebnis einer Konvertierung.
pub struct Converted {
    /// Endgültiger Zielpfad.
    pub output_path: String,
    /// Pfad, an dem die konvertierten Bytes aktuell liegen. Weicht bei
    /// In-place-Konvertierung (Temp-Datei) von `output_path` ab; der Aufrufer
    /// muss dann nach dem Finalisieren `written_path` → `output_path` verschieben.
    pub written_path: String,
}

/// Konvertiert eine einzelne Datei und streamt den Fortschritt via Event.
pub async fn convert_file(
    app: &AppHandle,
    id: &str,
    source: &str,
    opts: &ConvertOptions,
) -> AppResult<Converted> {
    // Für Ziel-Samplerate und Fortschrittsberechnung erst analysieren.
    let info = probe::probe(app, source).await?;
    let out = output_path(source, opts)?;
    let out_str = out.to_string_lossy().to_string();

    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).ok();
    }

    // In-place-Konvertierung (Ziel == Quelle) würde ffmpeg die gerade gelesene
    // Datei überschreiben. Daher in eine Temp-Datei schreiben und danach ersetzen.
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
                    emit_progress(app, id, pct, "Konvertiere");
                }
            }
            CommandEvent::Stderr(bytes) => {
                // Letzte ffmpeg-Ausgabe für Fehlermeldungen sammeln.
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
            emit_progress(app, id, 100, "Fertig");
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

/// Prüft, ob zwei Pfade auf dieselbe Datei zeigen.
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

/// Liefert einen freien Temp-Pfad neben dem Ziel (gleiche Endung für ffmpeg).
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

/// Parst eine ffmpeg-progress-Zeile und berechnet den Prozentwert.
fn parse_progress(chunk: &str, total_us: f64) -> Option<u32> {
    // ffmpeg gibt Blöcke mit key=value-Zeilen aus; out_time_us ist maßgeblich.
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
