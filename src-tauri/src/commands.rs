use std::sync::atomic::Ordering;

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::convert::ConvertProgress;
use crate::audio::{compat, convert, dedupe, probe};
use crate::bandcamp::session::BandcampState;
use crate::bandcamp::{collection, download, session};
use crate::error::{AppError, AppResult};
use crate::jobs::{BandcampDownloadState, DedupeState, ScanState, WatchState};
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
    let download_date = file_created_millis(&path);

    Some(TrackAnalysis {
        id: path.clone(),
        file_name: file_name(&path),
        path,
        audio,
        metadata,
        compat,
        metadata_incomplete,
        download_date,
    })
}

/// File creation time (falling back to modified time) as Unix millis.
fn file_created_millis(path: &str) -> Option<i64> {
    let meta = std::fs::metadata(path).ok()?;
    let time = meta.created().or_else(|_| meta.modified()).ok()?;
    time.duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as i64)
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

/// Lists all audio files under `dir` (recursive) without probing them — cheap,
/// used for the incremental library sync.
#[tauri::command]
pub fn list_audio_files(dir: String) -> Vec<String> {
    let mut out = Vec::new();
    collect_audio_files(std::path::Path::new(&dir), &mut out);
    out
}

/// Starts (or restarts) a debounced recursive watcher on `dir`. Any change emits
/// `library://changed`; the frontend then runs an incremental sync. An empty dir
/// stops watching.
#[tauri::command]
pub fn start_library_watch(
    app: AppHandle,
    state: State<'_, WatchState>,
    dir: String,
) -> AppResult<()> {
    use notify_debouncer_full::notify::RecursiveMode;
    use notify_debouncer_full::{new_debouncer, DebounceEventResult};
    use std::time::Duration;

    // Drop any existing watcher first (stops it).
    *state.debouncer.lock().unwrap() = None;
    if dir.trim().is_empty() {
        return Ok(());
    }

    let app = app.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(700),
        None,
        move |res: DebounceEventResult| {
            if let Ok(events) = res {
                if !events.is_empty() {
                    let _ = app.emit("library://changed", ());
                }
            }
        },
    )
    .map_err(|e| AppError::Metadata(format!("watcher init: {e}")))?;

    debouncer
        .watch(std::path::Path::new(&dir), RecursiveMode::Recursive)
        .map_err(|e| AppError::Metadata(format!("watch {dir}: {e}")))?;

    *state.debouncer.lock().unwrap() = Some(debouncer);
    Ok(())
}

/// Returns metadata suggestions (existing tags, file name guess,
/// MusicBrainz candidates) for manual confirmation.
#[tauri::command]
pub async fn suggest_metadata(
    path: String,
    discogs_key: Option<String>,
    discogs_secret: Option<String>,
) -> AppResult<MetadataSuggestions> {
    suggest::suggest(
        &path,
        discogs_key.as_deref().unwrap_or(""),
        discogs_secret.as_deref().unwrap_or(""),
    )
    .await
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

/// A trash context that moves items via `NSFileManager` instead of driving the
/// Finder — same reversible trash, but *without* the Finder "move to trash"
/// sound (and a bit faster).
fn trash_ctx() -> trash::TrashContext {
    use trash::macos::{DeleteMethod, TrashContextExtMacos};
    let mut ctx = trash::TrashContext::default();
    ctx.set_delete_method(DeleteMethod::NsFileManager);
    ctx
}

/// Trashes one path with the given context, mapping the outcome to a result.
fn trash_one(ctx: &trash::TrashContext, path: String) -> DeleteResult {
    match ctx.delete(&path) {
        Ok(()) => DeleteResult {
            path,
            success: true,
            error: None,
        },
        Err(e) => DeleteResult {
            path,
            success: false,
            error: Some(e.to_string()),
        },
    }
}

/// True if every audio file under `dir` (recursively) is one of `paths` — i.e.
/// the folder holds only this album, so trashing the whole folder is safe.
fn dir_holds_only(dir: &str, paths: &[String]) -> bool {
    let mut audio = Vec::new();
    collect_audio_files(std::path::Path::new(dir), &mut audio);
    if audio.is_empty() {
        return false;
    }
    let ours: std::collections::HashSet<&str> =
        paths.iter().map(String::as_str).collect();
    audio.iter().all(|p| ours.contains(p.as_str()))
}

/// Moves the given files to the trash (reversible, no Finder sound).
#[tauri::command]
pub async fn delete_files(paths: Vec<String>) -> Vec<DeleteResult> {
    let ctx = trash_ctx();
    paths.into_iter().map(|p| trash_one(&ctx, p)).collect()
}

/// Deletes a whole album: if `dir` contains no audio outside `paths`, the entire
/// folder (incl. artwork and other side files) is trashed in one operation;
/// otherwise only the given files are trashed and the folder is left in place.
/// Either way the result reports one entry per track path so the caller can
/// update its state uniformly.
#[tauri::command]
pub async fn delete_album(dir: String, paths: Vec<String>) -> Vec<DeleteResult> {
    let ctx = trash_ctx();
    if dir_holds_only(&dir, &paths) {
        if ctx.delete(&dir).is_ok() {
            return paths
                .into_iter()
                .map(|path| DeleteResult {
                    path,
                    success: true,
                    error: None,
                })
                .collect();
        }
        // Folder trash failed — fall through to trashing the files individually.
    }
    paths.into_iter().map(|p| trash_one(&ctx, p)).collect()
}

/// Trashes directories that no longer contain any audio files (re-checked here
/// for safety, recursively). Used to clean up an album folder after its
/// duplicate tracks were deleted. Folders that still hold audio (e.g. bonus
/// tracks) are left untouched.
#[tauri::command]
pub async fn prune_empty_dirs(dirs: Vec<String>) -> Vec<DeleteResult> {
    let ctx = trash_ctx();
    dirs.into_iter()
        .map(|d| {
            let mut audio = Vec::new();
            collect_audio_files(std::path::Path::new(&d), &mut audio);
            if !audio.is_empty() {
                return DeleteResult {
                    path: d,
                    success: false,
                    error: Some("directory still contains audio files".into()),
                };
            }
            trash_one(&ctx, d)
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
    dl_state: State<'_, BandcampDownloadState>,
    key: String,
    page_url: String,
    dest_dir: String,
    format: Option<String>,
) -> AppResult<BandcampDownloadResult> {
    let session = session::current(&state)?;

    // Register a cancel flag for this download so it can be aborted mid-stream.
    let cancel = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    dl_state
        .cancels
        .lock()
        .unwrap()
        .insert(key.clone(), cancel.clone());

    let result =
        download::download(&app, &session, &key, &page_url, &dest_dir, format.as_deref(), &cancel)
            .await;

    dl_state.cancels.lock().unwrap().remove(&key);

    match result {
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

/// Requests cancellation of an in-flight Bandcamp download.
#[tauri::command]
pub fn cancel_bandcamp_download(state: State<'_, BandcampDownloadState>, key: String) {
    if let Some(flag) = state.cancels.lock().unwrap().get(&key) {
        flag.store(true, Ordering::SeqCst);
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

    #[test]
    fn prune_empty_dirs_keeps_folders_with_audio() {
        let dir = tempfile::tempdir().unwrap();
        let with_audio = dir.path().join("has_audio");
        fs::create_dir_all(&with_audio).unwrap();
        fs::write(with_audio.join("bonus.mp3"), b"x").unwrap();

        let p = with_audio.to_string_lossy().to_string();
        let res = tauri::async_runtime::block_on(prune_empty_dirs(vec![p.clone()]));
        assert_eq!(res.len(), 1);
        assert!(!res[0].success, "folder with audio must not be deleted");
        assert!(with_audio.exists(), "folder must still exist");
    }

    #[test]
    fn dir_holds_only_detects_exclusive_album_folders() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.mp3");
        let b = dir.path().join("b.flac");
        fs::write(&a, b"x").unwrap();
        fs::write(&b, b"x").unwrap();
        fs::write(dir.path().join("cover.jpg"), b"x").unwrap(); // side file, ignored
        let root = dir.path().to_string_lossy().to_string();
        let a = a.to_string_lossy().to_string();
        let b = b.to_string_lossy().to_string();

        // Both audio files belong to the album → safe to trash the whole folder.
        assert!(dir_holds_only(&root, &[a.clone(), b.clone()]));
        // A foreign track remains → not safe, keep the folder.
        assert!(!dir_holds_only(&root, &[a.clone()]));
        // Empty / non-existent folder → nothing to trash.
        assert!(!dir_holds_only(&root, &[]));
        assert!(!dir_holds_only("/no/such/dir", &[a]));
    }
}
