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

/// Analysiert eine Liste von Dateien: Audio-Eigenschaften, CDJ-Kompatibilität
/// und vorhandene Metadaten. Nicht lesbare/keine Audiodateien werden übersprungen.
#[tauri::command]
pub async fn analyze_files(app: AppHandle, paths: Vec<String>) -> AppResult<Vec<TrackAnalysis>> {
    let mut out = Vec::with_capacity(paths.len());

    for path in paths {
        let audio = match probe::probe(&app, &path).await {
            Ok(a) => a,
            Err(_) => continue, // keine (lesbare) Audiodatei
        };

        let compat = compat::evaluate(&audio);
        let metadata = read_metadata(&path).unwrap_or_default();
        let metadata_incomplete = !metadata.is_complete();

        out.push(TrackAnalysis {
            id: path.clone(),
            file_name: file_name(&path),
            path,
            audio,
            metadata,
            compat,
            metadata_incomplete,
        });
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
            Ok(output_path) => {
                // Metadaten + Cover final via lofty schreiben.
                let _ = app.emit(
                    "convert://progress",
                    ConvertProgress {
                        id: job.id.clone(),
                        percent: 100,
                        stage: "Metadaten".into(),
                    },
                );
                match write::finalize(&output_path, &job.path, &job.metadata, &cover).await {
                    Ok(()) => ConvertResult {
                        id: job.id,
                        source_path: job.path,
                        output_path: Some(output_path),
                        success: true,
                        error: None,
                    },
                    Err(e) => ConvertResult {
                        id: job.id,
                        source_path: job.path,
                        output_path: Some(output_path),
                        success: false,
                        error: Some(format!("Konvertiert, aber Metadaten fehlgeschlagen: {e}")),
                    },
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

/// Meldet von Bandcamp ab (verwirft die Session im Speicher).
#[tauri::command]
pub async fn bandcamp_disconnect(state: State<'_, BandcampState>) -> AppResult<()> {
    session::disconnect(&state);
    Ok(())
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
