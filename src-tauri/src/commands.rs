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

/// Progress of the library scan (streamed to the frontend).
#[derive(Debug, Clone, serde::Serialize)]
struct ScanProgress {
    generation: u64,
    done: usize,
    total: usize,
    running: bool,
}

/// Completion event of the scan; delivers the result.
#[derive(Debug, Clone, serde::Serialize)]
struct ScanDone {
    generation: u64,
    cancelled: bool,
    tracks: Vec<TrackAnalysis>,
}

/// Current scan status (for reattaching after a reload).
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

/// Audio extensions considered during the library scan.
const AUDIO_EXTENSIONS: [&str; 11] = [
    "aiff", "aif", "wav", "flac", "alac", "m4a", "mp3", "aac", "ogg", "opus", "wma",
];

/// Analyzes a single file (audio properties, compatibility, metadata).
/// Returns `None` if it is not a (readable) audio file.
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

/// Analyzes a list of files: audio properties, CDJ compatibility
/// and existing metadata. Unreadable/non-audio files are skipped.
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

/// Recursively collects all files with an audio extension under `dir`.
fn collect_audio_files(dir: &std::path::Path, out: &mut Vec<String>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return, // skip unreadable folders
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

/// Starts a library scan as a background singleton. If one is already running,
/// nothing happens (returns `false`) - the running process stays in place.
/// The result arrives via `scan://done`, progress via `scan://progress`.
#[tauri::command]
pub fn start_scan(app: AppHandle, state: State<'_, ScanState>, dir: String) -> bool {
    // Single-flight: only start if a scan is not already running.
    if state.running.swap(true, Ordering::SeqCst) {
        return false;
    }
    state.cancel.store(false, Ordering::SeqCst);
    state.done.store(0, Ordering::SeqCst);
    state.total.store(0, Ordering::SeqCst);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;

    // A fresh scan means: the library has (possibly) changed -
    // so a cached duplicate result is now invalid.
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

/// Current scan status (for attaching to a running scan after a reload).
#[tauri::command]
pub fn scan_status(state: State<'_, ScanState>) -> ScanStatus {
    ScanStatus {
        running: state.running.load(Ordering::SeqCst),
        generation: state.generation.load(Ordering::SeqCst),
        done: state.done.load(Ordering::SeqCst),
        total: state.total.load(Ordering::SeqCst),
    }
}

/// Cancels a running scan (the task terminates at the next step).
#[tauri::command]
pub fn cancel_scan(state: State<'_, ScanState>) {
    if state.running.load(Ordering::SeqCst) {
        state.cancel.store(true, Ordering::SeqCst);
    }
}

/// Returns metadata suggestions (existing tags, file name guess,
/// MusicBrainz candidates) for manual confirmation.
#[tauri::command]
pub async fn suggest_metadata(path: String) -> AppResult<MetadataSuggestions> {
    suggest::suggest(&path).await
}

/// Returns a cover preview as a data: URL (already resized to <=800px/<100KB).
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

/// Returns a small embedded cover thumbnail as a data: URL for display
/// in the track list. `None` if the file does not contain a cover.
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

/// Converts the given jobs to the selected target format and then writes
/// confirmed metadata + cover. Progress via `convert://progress`.
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
                // Write metadata + cover finally via lofty.
                let _ = app.emit(
                    "convert://progress",
                    ConvertProgress {
                        id: job.id.clone(),
                        percent: 100,
                        stage: "Metadata".into(),
                    },
                );
                // Read the cover from the source (still intact for in-place), write tags
                // into the written file, then move it over the source if needed.
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
                                .map_err(|e| format!("Replacement failed: {e}"))
                        } else {
                            Ok(())
                        };
                        match moved {
                            Ok(()) => {
                                // Delete the original if requested and the output
                                // is a different file (e.g. format change).
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
                            error: Some(format!("Converted, but metadata failed: {e}")),
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

/// Completion event of the duplicate search.
#[derive(Debug, Clone, serde::Serialize)]
struct DedupeDone {
    generation: u64,
    cancelled: bool,
    groups: Vec<DuplicateGroup>,
}

/// Current dedupe status (for attaching/reopening).
#[derive(Debug, Clone, serde::Serialize)]
pub struct DedupeStatus {
    running: bool,
    generation: u64,
    done: usize,
    total: usize,
    stage: String,
    has_result: bool,
}

/// Starts the duplicate search as a background singleton. If one is already
/// running, nothing happens (`false`) - the running process stays in place.
/// The result arrives via `dedupe://done`, progress via `dedupe://progress`.
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
        *s = "Analyzing".to_string();
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

/// Current dedupe status (running + progress + whether a result is available).
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

/// Returns the result of the last completed run (if available).
#[tauri::command]
pub fn dedupe_result(state: State<'_, DedupeState>) -> Option<Vec<DuplicateGroup>> {
    state.result.lock().ok().and_then(|r| r.clone())
}

/// Cancels a running duplicate search.
#[tauri::command]
pub fn cancel_dedupe(state: State<'_, DedupeState>) {
    if state.running.load(Ordering::SeqCst) {
        state.cancel.store(true, Ordering::SeqCst);
    }
}

/// Moves the given files to the trash (reversible).
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

/// Opens the Bandcamp login window.
#[tauri::command]
pub async fn bandcamp_login(app: AppHandle) -> AppResult<()> {
    session::open_login(&app)
}

/// Takes over the session after login and returns the connected account.
#[tauri::command]
pub async fn bandcamp_connect(
    app: AppHandle,
    state: State<'_, BandcampState>,
) -> AppResult<BandcampAccount> {
    session::connect(&app, &state).await
}

/// Logs out from Bandcamp (discards the session in memory and in the store).
#[tauri::command]
pub async fn bandcamp_disconnect(
    app: AppHandle,
    state: State<'_, BandcampState>,
) -> AppResult<()> {
    session::disconnect(&app, &state);
    Ok(())
}

/// Returns the currently connected account (or `None` if no session exists).
#[tauri::command]
pub async fn bandcamp_status(
    state: State<'_, BandcampState>,
) -> AppResult<Option<BandcampAccount>> {
    Ok(session::status(&state))
}

/// Returns the purchased collection of the connected account.
#[tauri::command]
pub async fn bandcamp_collection(
    state: State<'_, BandcampState>,
) -> AppResult<Vec<BandcampItem>> {
    let session = session::current(&state)?;
    collection::list(&session).await
}

/// Downloads a purchased item (lossless) and returns the file paths.
/// The files can then be fed into the pipeline via `analyze_files`.
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn file_name_extracts_basename() {
        assert_eq!(file_name("/a/b/c.mp3"), "c.mp3");
        assert_eq!(file_name("song.flac"), "song.flac");
    }

    #[test]
    fn collect_audio_files_recurses_and_filters() {
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("album");
        fs::create_dir_all(&sub).unwrap();
        fs::write(dir.path().join("a.mp3"), b"x").unwrap();
        fs::write(dir.path().join("cover.jpg"), b"x").unwrap();
        fs::write(dir.path().join("notes.txt"), b"x").unwrap();
        fs::write(sub.join("b.FLAC"), b"x").unwrap(); // uppercase extension
        fs::write(sub.join("c.opus"), b"x").unwrap();

        let mut out = Vec::new();
        collect_audio_files(dir.path(), &mut out);
        out.sort();

        let names: Vec<String> = out
            .iter()
            .map(|p| file_name(p))
            .collect();
        assert!(names.contains(&"a.mp3".to_string()));
        assert!(names.contains(&"b.FLAC".to_string()));
        assert!(names.contains(&"c.opus".to_string()));
        assert!(!names.iter().any(|n| n.ends_with(".jpg") || n.ends_with(".txt")));
        assert_eq!(out.len(), 3);
    }
}
