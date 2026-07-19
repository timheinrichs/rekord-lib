use std::sync::atomic::Ordering;

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::convert::ConvertProgress;
use crate::audio::{compat, convert, dedupe, probe};
use crate::bandcamp::session::BandcampState;
use crate::bandcamp::{collection, download, session};
use crate::error::AppResult;
use crate::jobs::{DedupeState, ScanState};
use crate::metadata::read::read_metadata;
use crate::metadata::{artwork, suggest, write};
use crate::models::{
    BandcampAccount, BandcampDownloadResult, BandcampItem, ConvertJob, ConvertOptions,
    ConvertResult, CoverInput, DeleteResult, DupCandidate, DuplicateGroup, MetadataSuggestions,
    TrackAnalysis,
};

/// Fortschritt des Library-Scans (an das Frontend gestreamt).
#[derive(Debug, Clone, serde::Serialize)]
struct ScanProgress {
    generation: u64,
    done: usize,
    total: usize,
    running: bool,
}

/// Abschluss-Event des Scans; liefert das Ergebnis.
#[derive(Debug, Clone, serde::Serialize)]
struct ScanDone {
    generation: u64,
    cancelled: bool,
    tracks: Vec<TrackAnalysis>,
}

/// Aktueller Scan-Status (zum Wieder-Andocken nach Reload).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanStatus {
    running: bool,
    generation: u64,
    done: usize,
    total: usize,
}

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

/// Startet einen Library-Scan als Hintergrund-Singleton. Läuft bereits einer,
/// passiert nichts (Rückgabe `false`) – der laufende Prozess bleibt bestehen.
/// Ergebnis kommt via `scan://done`, Fortschritt via `scan://progress`.
#[tauri::command]
pub fn start_scan(app: AppHandle, state: State<'_, ScanState>, dir: String) -> bool {
    // Single-flight: nur starten, wenn nicht bereits ein Scan läuft.
    if state.running.swap(true, Ordering::SeqCst) {
        return false;
    }
    state.cancel.store(false, Ordering::SeqCst);
    state.done.store(0, Ordering::SeqCst);
    state.total.store(0, Ordering::SeqCst);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    // Ein frischer Scan bedeutet: die Library hat sich (evtl.) geändert –
    // ein zwischengespeichertes Duplikat-Ergebnis ist damit ungültig.
    if let Ok(mut r) = app.state::<DedupeState>().result.lock() {
        *r = None;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut paths = Vec::new();
        collect_audio_files(std::path::Path::new(&dir), &mut paths);
        let total = paths.len();
        app.state::<ScanState>().total.store(total, Ordering::SeqCst);
        let _ = app.emit(
            "scan://progress",
            ScanProgress {
                generation,
                done: 0,
                total,
                running: true,
            },
        );

        let mut out = Vec::with_capacity(total);
        let mut cancelled = false;
        for (i, path) in paths.into_iter().enumerate() {
            if app.state::<ScanState>().cancel.load(Ordering::SeqCst) {
                cancelled = true;
                break;
            }
            if let Some(track) = analyze_path(&app, path).await {
                out.push(track);
            }
            app.state::<ScanState>().done.store(i + 1, Ordering::SeqCst);
            let _ = app.emit(
                "scan://progress",
                ScanProgress {
                    generation,
                    done: i + 1,
                    total,
                    running: true,
                },
            );
        }

        app.state::<ScanState>().running.store(false, Ordering::SeqCst);
        let _ = app.emit(
            "scan://progress",
            ScanProgress {
                generation,
                done: app.state::<ScanState>().done.load(Ordering::SeqCst),
                total,
                running: false,
            },
        );
        let _ = app.emit(
            "scan://done",
            ScanDone {
                generation,
                cancelled,
                tracks: out,
            },
        );
    });
    true
}

/// Aktueller Scan-Status (zum Andocken an einen laufenden Scan nach Reload).
#[tauri::command]
pub fn scan_status(state: State<'_, ScanState>) -> ScanStatus {
    ScanStatus {
        running: state.running.load(Ordering::SeqCst),
        generation: state.generation.load(Ordering::SeqCst),
        done: state.done.load(Ordering::SeqCst),
        total: state.total.load(Ordering::SeqCst),
    }
}

/// Bricht einen laufenden Scan ab (der Task beendet sich beim nächsten Schritt).
#[tauri::command]
pub fn cancel_scan(state: State<'_, ScanState>) {
    if state.running.load(Ordering::SeqCst) {
        state.cancel.store(true, Ordering::SeqCst);
    }
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

/// Liefert ein kleines eingebettetes Cover-Thumbnail als data:-URL für die
/// Anzeige in der Track-Liste. `None`, wenn die Datei kein Cover enthält.
#[tauri::command]
pub async fn cover_thumbnail(path: String) -> AppResult<Option<String>> {
    match write::read_cover_or_sidecar(&path) {
        Some(bytes) => {
            let jpeg = artwork::thumbnail(&bytes, 96)?;
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
                            Ok(()) => {
                                // Original löschen, wenn gewünscht und die Ausgabe
                                // eine andere Datei ist (z. B. Formatwechsel).
                                if options.replace_source
                                    && converted.output_path != job.path
                                {
                                    let _ = std::fs::remove_file(&job.path);
                                }
                                ConvertResult {
                                    id: job.id,
                                    source_path: job.path,
                                    output_path: Some(converted.output_path),
                                    success: true,
                                    error: None,
                                }
                            }
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

/// Abschluss-Event der Duplikatsuche.
#[derive(Debug, Clone, serde::Serialize)]
struct DedupeDone {
    generation: u64,
    cancelled: bool,
    groups: Vec<DuplicateGroup>,
}

/// Aktueller Dedupe-Status (zum Andocken/erneuten Öffnen).
#[derive(Debug, Clone, serde::Serialize)]
pub struct DedupeStatus {
    running: bool,
    generation: u64,
    done: usize,
    total: usize,
    stage: String,
    has_result: bool,
}

/// Startet die Duplikatsuche als Hintergrund-Singleton. Läuft bereits eine,
/// passiert nichts (`false`) – der laufende Prozess bleibt bestehen.
/// Ergebnis via `dedupe://done`, Fortschritt via `dedupe://progress`.
#[tauri::command]
pub fn start_dedupe(
    app: AppHandle,
    state: State<'_, DedupeState>,
    candidates: Vec<DupCandidate>,
) -> bool {
    if state.running.swap(true, Ordering::SeqCst) {
        return false;
    }
    state.cancel.store(false, Ordering::SeqCst);
    state.done.store(0, Ordering::SeqCst);
    state.total.store(0, Ordering::SeqCst);
    if let Ok(mut s) = state.stage.lock() {
        *s = "Analysiere".to_string();
    }
    *state.result.lock().unwrap() = None;
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let (groups, cancelled) = dedupe::find_duplicates(&app, candidates, generation).await;
        let state = app.state::<DedupeState>();
        if !cancelled {
            *state.result.lock().unwrap() = Some(groups.clone());
        }
        state.running.store(false, Ordering::SeqCst);
        let _ = app.emit(
            "dedupe://done",
            DedupeDone {
                generation,
                cancelled,
                groups,
            },
        );
    });
    true
}

/// Aktueller Dedupe-Status (running + Fortschritt + ob ein Ergebnis vorliegt).
#[tauri::command]
pub fn dedupe_status(state: State<'_, DedupeState>) -> DedupeStatus {
    DedupeStatus {
        running: state.running.load(Ordering::SeqCst),
        generation: state.generation.load(Ordering::SeqCst),
        done: state.done.load(Ordering::SeqCst),
        total: state.total.load(Ordering::SeqCst),
        stage: state.stage.lock().map(|s| s.clone()).unwrap_or_default(),
        has_result: state.result.lock().map(|r| r.is_some()).unwrap_or(false),
    }
}

/// Liefert das Ergebnis des letzten abgeschlossenen Laufs (falls vorhanden).
#[tauri::command]
pub fn dedupe_result(state: State<'_, DedupeState>) -> Option<Vec<DuplicateGroup>> {
    state.result.lock().ok().and_then(|r| r.clone())
}

/// Bricht eine laufende Duplikatsuche ab.
#[tauri::command]
pub fn cancel_dedupe(state: State<'_, DedupeState>) {
    if state.running.load(Ordering::SeqCst) {
        state.cancel.store(true, Ordering::SeqCst);
    }
}

/// Verschiebt die angegebenen Dateien in den Papierkorb (umkehrbar).
#[tauri::command]
pub async fn delete_files(paths: Vec<String>) -> Vec<DeleteResult> {
    paths
        .into_iter()
        .map(|p| match trash::delete(&p) {
            Ok(()) => DeleteResult {
                path: p,
                success: true,
                error: None,
            },
            Err(e) => DeleteResult {
                path: p,
                success: false,
                error: Some(e.to_string()),
            },
        })
        .collect()
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
    app: AppHandle,
    state: State<'_, BandcampState>,
    key: String,
    page_url: String,
    dest_dir: String,
) -> AppResult<BandcampDownloadResult> {
    let session = session::current(&state)?;
    match download::download(&app, &session, &key, &page_url, &dest_dir).await {
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
