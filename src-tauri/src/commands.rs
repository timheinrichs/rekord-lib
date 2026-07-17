use base64::Engine;
use tauri::{AppHandle, Emitter, State};

use crate::audio::convert::ConvertProgress;
use crate::audio::{compat, convert, probe};
use crate::bandcamp::session::BandcampState;
use crate::bandcamp::{collection, download, session};
use crate::error::AppResult;
use crate::metadata::read::read_metadata;
use crate::metadata::{artwork, suggest, write};
use crate::models::{
    BandcampAccount, BandcampDownloadResult, BandcampItem, ConvertJob, ConvertOptions,
    ConvertResult, CoverInput, MetadataSuggestions, TrackAnalysis,
};

fn file_name(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

/// Audio-Endungen, die beim Library-Scan berücksichtigt werden.
const AUDIO_EXTENSIONS: [&str; 11] = [
    "aiff", "aif", "wav", "flac", "alac", "m4a", "mp3", "aac", "ogg", "opus", "wma",
];

/// Analysiert eine einzelne Datei (Audio-Eigenschaften, Kompatibilität, Metadaten).
/// Liefert `None`, wenn es keine (lesbare) Audiodatei ist.
async fn analyze_path(app: &AppHandle, path: String) -> Option<TrackAnalysis> {
    let audio = probe::probe(app, &path).await.ok()?;
    let compat = compat::evaluate(&audio);
    let metadata = read_metadata(&path).unwrap_or_default();
    let metadata_incomplete = !metadata.is_complete();

    Some(TrackAnalysis {
        id: path.clone(),
        file_name: file_name(&path),
        path,
        audio,
        metadata,
        compat,
        metadata_incomplete,
    })
}

/// Analysiert eine Liste von Dateien: Audio-Eigenschaften, CDJ-Kompatibilität
/// und vorhandene Metadaten. Nicht lesbare/keine Audiodateien werden übersprungen.
#[tauri::command]
pub async fn analyze_files(app: AppHandle, paths: Vec<String>) -> AppResult<Vec<TrackAnalysis>> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        if let Some(track) = analyze_path(&app, path).await {
            out.push(track);
        }
    }
    Ok(out)
}

/// Sammelt rekursiv alle Dateien mit Audio-Endung unter `dir`.
fn collect_audio_files(dir: &std::path::Path, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // nicht lesbare Ordner überspringen
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_audio_files(&path, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| AUDIO_EXTENSIONS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false)
        {
            out.push(path.to_string_lossy().to_string());
        }
    }
}

/// Scannt den Library-Ordner rekursiv und analysiert alle gefundenen Audiodateien.
#[tauri::command]
pub async fn scan_library(app: AppHandle, dir: String) -> AppResult<Vec<TrackAnalysis>> {
    let mut paths = Vec::new();
    collect_audio_files(std::path::Path::new(&dir), &mut paths);

    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        if let Some(track) = analyze_path(&app, path).await {
            out.push(track);
        }
    }
    Ok(out)
}

/// Liefert Metadaten-Vorschläge (vorhandene Tags, Dateiname-Vermutung,
/// MusicBrainz-Kandidaten) zur manuellen Bestätigung.
#[tauri::command]
pub async fn suggest_metadata(path: String) -> AppResult<MetadataSuggestions> {
    suggest::suggest(&path).await
}

/// Liefert eine Cover-Vorschau als data:-URL (bereits auf ≤800px/<100KB gebracht).
#[tauri::command]
pub async fn cover_preview(source: String, cover: CoverInput) -> AppResult<Option<String>> {
    let raw = write::resolve_cover(&source, &cover).await?;
    match raw {
        Some(bytes) => {
            let jpeg = artwork::process_cover(&bytes)?;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&jpeg);
            Ok(Some(format!("data:image/jpeg;base64,{b64}")))
        }
        None => Ok(None),
    }
}

/// Konvertiert die übergebenen Aufträge in das gewählte Zielformat und schreibt
/// anschließend bestätigte Metadaten + Cover. Fortschritt via `convert://progress`.
#[tauri::command]
pub async fn convert_tracks(
    app: AppHandle,
    jobs: Vec<ConvertJob>,
    options: ConvertOptions,
) -> AppResult<Vec<ConvertResult>> {
    let mut results = Vec::with_capacity(jobs.len());

    for job in jobs {
        let cover = job.cover.clone().unwrap_or_default();

        let result = match convert::convert_file(&app, &job.id, &job.path, &options).await {
            Ok(converted) => {
                // Metadaten + Cover final via lofty schreiben.
                let _ = app.emit(
                    "convert://progress",
                    ConvertProgress {
                        id: job.id.clone(),
                        percent: 100,
                        stage: "Metadaten".into(),
                    },
                );
                // Cover aus der (bei In-place noch intakten) Quelle lesen, Tags in die
                // geschriebene Datei schreiben, danach ggf. über die Quelle verschieben.
                let finalized = write::finalize(
                    &converted.written_path,
                    &job.path,
                    &job.metadata,
                    &cover,
                )
                .await;

                match finalized {
                    Ok(()) => {
                        let moved = if converted.written_path != converted.output_path {
                            std::fs::rename(&converted.written_path, &converted.output_path)
                                .map_err(|e| format!("Ersetzen fehlgeschlagen: {e}"))
                        } else {
                            Ok(())
                        };
                        match moved {
                            Ok(()) => ConvertResult {
                                id: job.id,
                                source_path: job.path,
                                output_path: Some(converted.output_path),
                                success: true,
                                error: None,
                            },
                            Err(msg) => {
                                let _ = std::fs::remove_file(&converted.written_path);
                                ConvertResult {
                                    id: job.id,
                                    source_path: job.path,
                                    output_path: None,
                                    success: false,
                                    error: Some(msg),
                                }
                            }
                        }
                    }
                    Err(e) => {
                        if converted.written_path != converted.output_path {
                            let _ = std::fs::remove_file(&converted.written_path);
                        }
                        ConvertResult {
                            id: job.id,
                            source_path: job.path,
                            output_path: Some(converted.output_path),
                            success: false,
                            error: Some(format!("Konvertiert, aber Metadaten fehlgeschlagen: {e}")),
                        }
                    }
                }
            }
            Err(e) => ConvertResult {
                id: job.id,
                source_path: job.path,
                output_path: None,
                success: false,
                error: Some(e.to_string()),
            },
        };

        results.push(result);
    }

    Ok(results)
}

// ---------------------------------------------------------------------------
// Bandcamp (Phase 3)
// ---------------------------------------------------------------------------

/// Öffnet das Bandcamp-Login-Fenster.
#[tauri::command]
pub async fn bandcamp_login(app: AppHandle) -> AppResult<()> {
    session::open_login(&app)
}

/// Übernimmt die Session nach dem Login und liefert das verbundene Konto.
#[tauri::command]
pub async fn bandcamp_connect(
    app: AppHandle,
    state: State<'_, BandcampState>,
) -> AppResult<BandcampAccount> {
    session::connect(&app, &state).await
}

/// Meldet von Bandcamp ab (verwirft die Session im Speicher und im Store).
#[tauri::command]
pub async fn bandcamp_disconnect(
    app: AppHandle,
    state: State<'_, BandcampState>,
) -> AppResult<()> {
    session::disconnect(&app, &state);
    Ok(())
}

/// Liefert das aktuell verbundene Konto (oder `None`, wenn keine Session besteht).
#[tauri::command]
pub async fn bandcamp_status(
    state: State<'_, BandcampState>,
) -> AppResult<Option<BandcampAccount>> {
    Ok(session::status(&state))
}

/// Liefert die gekaufte Sammlung des verbundenen Kontos.
#[tauri::command]
pub async fn bandcamp_collection(
    state: State<'_, BandcampState>,
) -> AppResult<Vec<BandcampItem>> {
    let session = session::current(&state)?;
    collection::list(&session).await
}

/// Lädt ein gekauftes Item herunter (verlustfrei) und liefert die Dateipfade.
/// Die Dateien können anschließend über `analyze_files` in die Pipeline.
#[tauri::command]
pub async fn bandcamp_download(
    state: State<'_, BandcampState>,
    key: String,
    page_url: String,
    dest_dir: String,
) -> AppResult<BandcampDownloadResult> {
    let session = session::current(&state)?;
    match download::download(&session, &page_url, &dest_dir).await {
        Ok(files) => Ok(BandcampDownloadResult {
            key,
            files,
            success: true,
            error: None,
        }),
        Err(e) => Ok(BandcampDownloadResult {
            key,
            files: Vec::new(),
            success: false,
            error: Some(e.to_string()),
        }),
    }
}
