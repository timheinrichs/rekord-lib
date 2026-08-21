use std::sync::atomic::Ordering;

use base64::Engine;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::convert::ConvertProgress;
use crate::audio::{analysis, bpm, compat, convert, dedupe, probe, waveform, workers};
use crate::bandcamp::session::BandcampState;
use crate::bandcamp::{collection, download, session};
use crate::db::{self, FsIdentity, TrackRecord};
use crate::error::{AppError, AppResult};
use crate::events;
use crate::jobs::{BandcampDownloadState, DedupeState, ScanState, WatchState};
use crate::metadata::read::read_metadata;
use crate::metadata::{artwork, suggest, write};
use crate::models::{
    BandcampAccount, BandcampDownloadResult, BandcampItem, ConvertJob, ConvertOptions,
    ConvertResult, CoverInput, DeleteResult, DupCandidate, DuplicateGroup, EventLog,
    MetadataSuggestions,
    RelocateResult, SkippedFile, TrackAnalysis, UndoEntry, WriteMetadataItem,
};

/// Progress of the library scan (streamed to the frontend).
#[derive(Debug, Clone, serde::Serialize)]
struct ScanProgress {
    generation: u64,
    done: usize,
    total: usize,
    running: bool,
    /// Held between units of work. The counters keep their meaning — they say
    /// where the run will continue from.
    paused: bool,
    /// Which pass the counters refer to, e.g. "Analyzing" or "Detecting BPM".
    stage: String,
}

/// Scan stage labels (also shown verbatim in the UI).
const STAGE_ANALYZING: &str = "Analyzing";
/// What the analysis pass is doing, which depends on what the tracks are
/// missing: a fresh library needs both, a library another program has tagged
/// needs only keys. Reported so the scan button says which.
const STAGE_BPM: &str = "Detecting BPM";
const STAGE_KEY: &str = "Detecting key";
const STAGE_BPM_KEY: &str = "Detecting BPM & key";
const STAGE_WAVEFORM: &str = "Drawing waveforms";

/// The label for a pass over `todo`, whose entries carry what each track needs.
fn analysis_stage(wants_tempo: bool, wants_key: bool) -> &'static str {
    match (wants_tempo, wants_key) {
        (true, true) => STAGE_BPM_KEY,
        (false, true) => STAGE_KEY,
        (true, false) => STAGE_BPM,
        // Only waveforms left: the same decode, nothing detected from it.
        (false, false) => STAGE_WAVEFORM,
    }
}

/// One track's share of an analysis pass.
struct Todo {
    index: usize,
    path: String,
    wanted: analysis::Wanted,
}
const STAGE_DUPLICATES: &str = "Finding duplicates";

/// Most concurrent ffmpeg processes in the BPM pass — the measured value, which
/// [`workers::budget`] may lower but never raises. Same ceiling as the duplicate
/// search's fingerprint pass.
const BPM_CONCURRENCY: usize = 8;

/// Memory to reserve per worker in the BPM pass. The pass is the one place that
/// decodes a **whole** file: mono `i16` at 11025 Hz, held in the raw byte buffer
/// and in the sample vector at once (`audio::decode::mono_pcm`), so about
/// 44 kB per second of audio — ~26 MB for a 10-minute track, ~160 MB for a
/// one-hour set. 96 MB covers a long track with room for ffmpeg's own footprint;
/// a machine that cannot afford that many gets fewer workers instead of an
/// allocation failure halfway through the batch.
const BPM_WORKER_BYTES: u64 = 96 * 1024 * 1024;

/// Below this confidence a detected tempo is kept but **not** written into the
/// file. The value still reaches the library, so the UI can show it as
/// uncertain and the user can accept it by hand — it just does not get baked
/// into thousands of files on a guess.
///
/// A wrong tag is worse than no tag in both directions: on an untagged file it
/// invents a number, and on a `force` re-detection it destroys one the user may
/// have set deliberately.
///
/// **Measured, not chosen.** Over the 2143 reference tracks that produce a
/// tempo at all (`docs/DSP_BENCHMARK.md`), what each threshold prevents against
/// what it costs:
///
/// | threshold | wrong tags prevented | correct ones lost |
/// |---|---|---|
/// | 0.30 | 20 | 4 |
/// | 0.40 | 23 | 14 |
/// | 0.60 | 66 | 67 |
/// | 0.90 | 201 | 375 |
///
/// 0.30 trades five to one in our favour; past 0.6 the trade is break-even and
/// beyond that it destroys more than it saves, because most of the collection
/// scores above 0.9 and is 92 % correct there.
///
/// Worth being honest about the ceiling: this gate stops 20 of 327 wrong values,
/// about 6 %. The confidence separates hopeless from plausible, not right from
/// wrong. What actually protects the files is the hard gate in `audio::bpm`
/// (which returns nothing at all rather than a guess) and undo.
const MIN_WRITE_CONFIDENCE: f32 = 0.30;

/// The detector's configuration from what the frontend passed. `None` means the
/// caller has no opinion — an older frontend, or an internal call — and the
/// detector's own defaults apply. Out-of-order or absurd values are corrected
/// inside `TempoConfig`, not here, so every entry point behaves the same.
fn tempo_config(bpm_min: Option<f32>, bpm_max: Option<f32>) -> bpm::TempoConfig {
    let default = bpm::TempoConfig::default();
    bpm::TempoConfig {
        min_bpm: bpm_min.unwrap_or(default.min_bpm),
        max_bpm: bpm_max.unwrap_or(default.max_bpm),
        ..default
    }
}

/// Concurrent ffprobe processes in the analysis pass. One probe is short
/// (~100 ms, dominated by process startup rather than CPU), so the pass is
/// bound by how many can be in flight at once, not by cores.
///
/// Deliberately outside [`workers::budget`] for the same reason: ffprobe reads
/// headers rather than audio, so it holds nothing worth budgeting, and the
/// measurement above says cores are not what limits this pass. Lowering it with
/// the others would cost scan time to solve a problem it does not have.
const PROBE_CONCURRENCY: usize = 8;

/// Completion event of the scan. The tracks arrive over `scan://tracks` while
/// the job runs, so this only reports how it ended.
#[derive(Debug, Clone, serde::Serialize)]
struct ScanDone {
    generation: u64,
    cancelled: bool,
    /// True for a full sweep of the library, false when only a subset of paths
    /// was processed — the frontend must not drop untouched tracks then.
    full: bool,
    tracks: Vec<TrackAnalysis>,
}

/// A batch of freshly analyzed tracks, streamed while the job runs so results
/// are visible and persisted long before it finishes.
#[derive(Debug, Clone, serde::Serialize)]
struct ScanTracks {
    generation: u64,
    tracks: Vec<TrackAnalysis>,
}

/// How many tracks to collect before emitting a batch.
const SCAN_BATCH: usize = 25;

/// What a finished analysis has to say about one track. Only the fields it
/// actually produced are set: absent means "unchanged", not "not detected" — the
/// pass never clears a value it failed to find, so the frontend can patch a row
/// field by field without having to know what the rest of it looks like.
#[derive(Debug, Clone, Default, serde::Serialize)]
struct TrackPatch {
    path: String,
    bpm: Option<f64>,
    bpm_confidence: Option<f32>,
    key: Option<String>,
    key_camelot: Option<String>,
    key_confidence: Option<f32>,
    /// A waveform was stored for this path. A signal rather than a payload: the
    /// waveform lives in its own table and is fetched by the row that draws it.
    waveform: bool,
}

impl TrackPatch {
    /// Nothing came out of the analysis, so there is nothing to tell anyone.
    fn is_empty(&self) -> bool {
        self.bpm.is_none() && self.key.is_none() && !self.waveform
    }

    /// Whether the **track row** changed, which is what decides whether it has
    /// to be written back. A waveform alone does not: it lives in its own table,
    /// so the row has nothing new to persist for it.
    fn changes_row(&self) -> bool {
        self.bpm.is_some() || self.key.is_some()
    }
}

/// One track's analysis result, streamed the moment it is finished instead of at
/// the end of its chunk.
#[derive(Debug, Clone, serde::Serialize)]
struct ScanPatch {
    generation: u64,
    patch: TrackPatch,
}

/// The fields an analysis result carries over into a track row. Pure — the tag
/// write, the waveform store and the emit all happen around it, so the mapping
/// itself can be tested without a running app.
fn patch_of(path: &str, analysis: &analysis::Analysis) -> TrackPatch {
    let mut patch = TrackPatch {
        path: path.to_string(),
        ..Default::default()
    };
    if let Some(tempo) = analysis.tempo.as_ref() {
        // Rounded to the precision a tag can hold before it is stored anywhere.
        // Without this the f32 -> f64 widening leaks artefacts like
        // 127.5999984741211 into the database and the UI, while the file would
        // say "127.60" — three places, one value, no reason to disagree.
        patch.bpm = Some((tempo.bpm as f64 * 100.0).round() / 100.0);
        patch.bpm_confidence = Some(tempo.confidence);
    }
    if let Some(detected) = analysis.key.as_ref() {
        patch.key = Some(detected.key.name());
        patch.key_camelot = Some(detected.key.camelot_name());
        patch.key_confidence = Some(detected.confidence);
    }
    patch
}

/// Writes a patch into the row it belongs to. Only the fields the patch carries
/// are touched.
fn apply_patch(track: &mut TrackAnalysis, patch: &TrackPatch) {
    if let Some(bpm) = patch.bpm {
        track.metadata.bpm = Some(bpm);
        track.bpm_confidence = patch.bpm_confidence;
    }
    if patch.key.is_some() {
        track.key = patch.key.clone();
        track.key_camelot = patch.key_camelot.clone();
        track.key_confidence = patch.key_confidence;
    }
}

/// Current scan status (for reattaching after a reload).
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanStatus {
    running: bool,
    paused: bool,
    generation: u64,
    done: usize,
    total: usize,
    stage: String,
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
///
/// The error is part of the result on purpose: a file that cannot be probed is
/// skipped, and the caller needs the reason to be able to report it.
async fn analyze_path(app: &AppHandle, path: String) -> AppResult<TrackAnalysis> {
    let audio = probe::probe(app, &path).await?;
    let compat = compat::evaluate(&audio);
    let metadata = read_metadata(&path).unwrap_or_default();
    let metadata_incomplete = !metadata.is_complete();
    let download_date = file_created_millis(&path);

    Ok(TrackAnalysis {
        id: path.clone(),
        file_name: file_name(&path),
        path,
        audio,
        metadata,
        compat,
        metadata_incomplete,
        download_date,
        // The scan's analysis pass fills these in; a plain probe has no opinion.
        bpm_confidence: None,
        key: None,
        key_camelot: None,
        key_confidence: None,
    })
}

/// Reports a file the analysis could not use.
///
/// Skipping is the right behaviour — one unreadable file must never abort a
/// run over thousands — but it used to happen silently, with the reason thrown
/// away at `analyze_path`. Every path that drops a file now says so here, and
/// the frontend collects them into one list.
fn record_skip(app: &AppHandle, path: &str, reason: String) {
    // Also in the log: the header count is gone on the next restart, and "why
    // is this track not in my library" outlives the session it happened in.
    events::warn(app, "scan", &format!("Skipped {}", file_name(path)), Some(&format!("{path}: {reason}")));
    let _ = app.emit(
        "scan://skipped",
        SkippedFile {
            path: path.to_string(),
            file_name: file_name(path),
            reason,
        },
    );
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
pub async fn analyze_files(
    app: AppHandle,
    paths: Vec<String>,
    analyze_bpm: bool,
    library_dir: Option<String>,
    bpm_min: Option<f32>,
    bpm_max: Option<f32>,
) -> AppResult<Vec<TrackAnalysis>> {
    // Stat before probing (see the scan loop for why that order matters).
    let mut ids: Vec<Option<FsIdentity>> = Vec::with_capacity(paths.len());
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let fs = db::fs_identity(&path);
        match analyze_path(&app, path.clone()).await {
            Ok(track) => {
                ids.push(fs);
                out.push(track);
            }
            Err(e) => record_skip(&app, &path, e.to_string()),
        }
    }
    if analyze_bpm {
        // Synchronous path: the caller gets the finished tracks as the return
        // value, so there is nothing to stream and nothing to cancel.
        detect_bpm_pass(
            &app,
            &mut out,
            false,
            tempo_config(bpm_min, bpm_max),
            |_| {},
            |_, _| {},
            |_| {},
            |_| {},
            || false,
        )
        .await;
        // The tempo write changed every touched file, so the identities taken
        // above are stale — take them again.
        ids = out.iter().map(|t| db::fs_identity(&t.path)).collect();
    }

    // Persist only for a library analysis, and only for files that really sit
    // inside that folder: this command also serves imported files from
    // anywhere on disk, which have no business in the library table.
    if let Some(dir) = library_dir.filter(|d| !d.is_empty()) {
        let records: Vec<TrackRecord> = out
            .iter()
            .zip(&ids)
            .filter(|(track, _)| is_inside(&dir, &track.path))
            .map(|(track, fs)| TrackRecord {
                track: track.clone(),
                fs: *fs,
            })
            .collect();
        persist_tracks(&app, &dir, &records);
    }
    Ok(out)
}

/// Opens the **saved** library folder for playback (`asset:`), and nothing else.
///
/// Takes no folder, deliberately: the folder comes from the saved settings — the
/// one the user chose — so the frontend calls this after the save rather than
/// instead of it, and a stray call cannot name a folder of its own.
///
/// It is a narrowing, not a boundary, and the difference is worth being honest
/// about. The window holds `store:default`, so code running there could write
/// `settings.library_dir` itself and then ask for that. What is gone is the
/// unconditional grant: `$HOME/**` and `/Volumes/**` were readable before
/// anything asked, and now nothing is until a folder has been saved as the
/// library. A hard boundary would mean the backend owning the setting.
///
/// The scope is runtime state, so it has to be granted again after a change,
/// and it is never revoked mid-run: a track playing when the folder changes
/// would otherwise stop halfway. The next start begins from nothing.
#[tauri::command]
pub fn allow_library_playback(app: AppHandle) {
    crate::assets::allow_saved_library(&app);
}

/// Is `path` inside `dir`? Used to keep an imported file's analysis out of the
/// library table. Compared on the path text, which is what both sides carry.
pub(crate) fn is_inside(dir: &str, path: &str) -> bool {
    let dir = dir.trim_end_matches(std::path::MAIN_SEPARATOR);
    path.starts_with(dir)
        && path.len() > dir.len()
        && path[dir.len()..].starts_with(std::path::MAIN_SEPARATOR)
}

/// Detects the BPM of tracks, writes it into the file's tag and updates the
/// track in place. By default tracks that already carry a BPM are skipped —
/// that, plus writing what we detect, means a given file is analyzed once ever.
/// `force` re-analyzes regardless, which is what makes an improved detector
/// reachable for a library that is already tagged.
///
/// Runs at most [`BPM_CONCURRENCY`] decodes at a time (see
/// [`workers::budget`]). `progress(done, total)` is called per finished file, so
/// is `patch(..)` for whatever that file produced; `persist(updated)` runs
/// after every chunk, because one transaction per chunk is worth far more than
/// one per file; `cancelled()` is polled between chunks. Returns whether it
/// stopped early.
#[allow(clippy::too_many_arguments)]
async fn detect_bpm_pass(
    app: &AppHandle,
    tracks: &mut [TrackAnalysis],
    force: bool,
    config: bpm::TempoConfig,
    mut stage: impl FnMut(&'static str),
    mut progress: impl FnMut(usize, usize),
    mut patch: impl FnMut(TrackPatch),
    mut persist: impl FnMut(Vec<TrackAnalysis>),
    cancelled: impl Fn() -> bool,
) -> bool {
    // Which files already have a usable waveform. Asked once for the whole
    // batch rather than per track: it is one query either way, and a waveform is
    // the only one of the three answers that lives outside the track row.
    let identities: std::collections::HashMap<String, db::FsIdentity> = tracks
        .iter()
        .filter_map(|t| db::fs_identity(&t.path).map(|fs| (t.path.clone(), fs)))
        .collect();
    let have_waveform = if force {
        std::collections::HashSet::new()
    } else {
        load_waveform_paths(app, &identities)
    };

    // What each track still needs. A file may carry a tempo tag but no key,
    // which is the normal state of a library that another program has touched.
    let todo: Vec<Todo> = tracks
        .iter()
        .enumerate()
        .map(|(i, t)| Todo {
            index: i,
            path: t.path.clone(),
            wanted: analysis::Wanted {
                tempo: force || t.metadata.bpm.is_none(),
                key: force || t.key.is_none(),
                waveform: force || !have_waveform.contains(&t.path),
            },
        })
        .filter(|t| t.wanted.tempo || t.wanted.key || t.wanted.waveform)
        .collect();
    let total = todo.len();
    if total == 0 {
        return false;
    }
    // Announced once the work is known, not before: the caller cannot tell what
    // is missing without walking the same list.
    stage(analysis_stage(
        todo.iter().any(|t| t.wanted.tempo),
        todo.iter().any(|t| t.wanted.key),
    ));

    // Asked once per pass rather than once per process: the free memory of a
    // machine changes over a session, so a scan started while another app held
    // 8 GB should not keep that width for the rest of the run.
    let host = workers::Host::detect();
    let width = workers::budget(
        host,
        BPM_WORKER_BYTES,
        BPM_CONCURRENCY,
        workers::override_jobs(),
    );
    // Said out loud, like the fingerprint cache line: "the scan is slow" is a
    // real report, and the width is the first thing worth knowing about it.
    println!(
        "Analysis width: {width} ({} cores, {} MB free)",
        host.cores,
        host.available_bytes / (1024 * 1024)
    );

    let mut done = 0;
    for chunk in todo.chunks(width) {
        // await_resume returns at once unless a scan is paused, so the
        // synchronous path through analyze_files is unaffected.
        if cancelled() || await_resume(app).await {
            return true;
        }
        let handles: Vec<(usize, _)> = chunk
            .iter()
            .map(|item| {
                let app = app.clone();
                let path = item.path.clone();
                let wanted = item.wanted;
                (
                    item.index,
                    tauri::async_runtime::spawn(async move {
                        analysis::analyze(&app, &path, config, wanted)
                            .await
                            .unwrap_or_default()
                    }),
                )
            })
            .collect();

        let mut updated = Vec::new();
        for (index, handle) in handles {
            if let Ok(analysis) = handle.await {
                let mut result = patch_of(&tracks[index].path, &analysis);
                if let (Some(bpm), Some(confidence)) = (result.bpm, result.bpm_confidence) {
                    // Persist first: the tag is what keeps the next scan from
                    // re-analyzing this file. A failed write is not fatal — the
                    // value still shows up in the library for this session.
                    if confidence >= MIN_WRITE_CONFIDENCE {
                        if let Err(e) = write::write_bpm(&tracks[index].path, bpm) {
                            events::warn(
                                app,
                                "bpm",
                                "Detected a tempo but could not write it into the file",
                                Some(&format!("{}: {e}", tracks[index].path)),
                            );
                        }
                    }
                }
                if let Some(w) = analysis.waveform.as_ref() {
                    // Saved with an identity taken *after* any tag write above:
                    // that write changed the file, and a waveform stamped with
                    // the old mtime would be discarded on the next read.
                    if let Some(fs) = db::fs_identity(&tracks[index].path) {
                        save_waveform(app, &tracks[index].path, fs, w);
                        result.waveform = true;
                    }
                }
                // The key is database-only, never written into the file — see
                // `TrackAnalysis::key`.
                apply_patch(&mut tracks[index], &result);
                if result.changes_row() {
                    updated.push(tracks[index].clone());
                }
                // Handed over the moment it exists, rather than at the end of
                // the chunk: the row on screen fills in while the scan runs, and
                // a waveform-only result — which changes no column of the row —
                // reaches the list at all.
                if !result.is_empty() {
                    patch(result);
                }
            }
            done += 1;
            progress(done, total);
        }
        // Persist the chunk before starting the next one, so a cancel or a quit
        // costs at most one chunk of work.
        persist(updated);
    }
    false
}

/// Paths whose stored waveform still matches the file on disk.
fn load_waveform_paths(
    app: &AppHandle,
    identities: &std::collections::HashMap<String, db::FsIdentity>,
) -> std::collections::HashSet<String> {
    // `db::require`, not `app.state`: the latter panics when the database was
    // never managed, and `lib.rs` deliberately starts the app without one when
    // `Db::open` failed. A panic here happens inside an async command task,
    // where it never settles the `invoke` promise — so the frontend hangs
    // instead of seeing an error.
    let Ok(state) = db::require(app) else {
        return std::collections::HashSet::new();
    };
    let Ok(conn) = state.conn() else {
        return std::collections::HashSet::new();
    };
    db::waveforms_load(&conn, identities, waveform::ALGO_VERSION)
        .map(|m| m.into_keys().collect())
        .unwrap_or_default()
}

/// Stores one waveform. A failure is not worth interrupting a scan for — the
/// list simply shows no waveform for that track until the next run.
fn save_waveform(
    app: &AppHandle,
    path: &str,
    fs: db::FsIdentity,
    w: &waveform::Waveform,
) {
    let Ok(state) = db::require(app) else {
        return;
    };
    let Ok(conn) = state.conn() else {
        return;
    };
    if let Err(e) = db::waveform_save(
        &conn,
        path,
        fs,
        waveform::ALGO_VERSION,
        &waveform::to_bytes(w),
    ) {
        events::warn(
            app,
            "waveform",
            "Could not store a waveform",
            Some(&format!("{path}: {e}")),
        );
    }
}

/// Stored waveforms for the given paths, keyed by path.
///
/// Takes a list rather than one path because the library view asks for whatever
/// is on screen: one query for twenty rows instead of twenty round trips. Paths
/// with no usable stored waveform are simply absent from the result — the row
/// then draws nothing rather than the app inventing a shape.
#[tauri::command]
pub fn stored_waveforms(
    app: AppHandle,
    paths: Vec<String>,
) -> AppResult<std::collections::HashMap<String, waveform::Waveform>> {
    let identities: std::collections::HashMap<String, db::FsIdentity> = paths
        .iter()
        .filter_map(|p| db::fs_identity(p).map(|fs| (p.clone(), fs)))
        .collect();
    let state = db::require(&app)?;
    let conn = state.conn()?;
    Ok(db::waveforms_load(&conn, &identities, waveform::ALGO_VERSION)?
        .into_iter()
        .map(|(path, blob)| (path, waveform::from_bytes(&blob)))
        .collect())
}

/// The waveform overview of one file, for the player bar.
///
/// Computed on demand rather than cached on disk: it is only ever needed for the
/// track that is playing, the frontend keeps the recent ones in memory, and a
/// stored copy would be ~19 KB per track with an invalidation contract to
/// maintain for a sub-second saving on a replay. The dense per-track data that
/// *does* need storing is the ANLZ waveform (roadmap H1), which is a different
/// artifact.
#[tauri::command]
pub async fn waveform(app: AppHandle, path: String) -> AppResult<waveform::Waveform> {
    waveform::analyze(&app, &path).await
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

/// Starts the library scan as a background singleton. If one is already running,
/// nothing happens (returns `false`) — the running job stays in place.
///
/// One job covers every case: `paths = None` sweeps the whole library, `Some`
/// processes exactly those files (a handful of new ones, or the backlog of
/// tracks still missing a BPM), `force_bpm` re-detects even where a tempo is
/// already present, and `force` re-probes even files the database still
/// considers unchanged. Results stream out over `scan://tracks` as they are
/// produced, so nothing is lost when the job is cancelled or the app quits
/// mid-run; `scan://done` only reports how it ended.
#[tauri::command]
pub fn start_scan(
    app: AppHandle,
    state: State<'_, ScanState>,
    dir: String,
    analyze_bpm: bool,
    paths: Option<Vec<String>>,
    force_bpm: bool,
    force: bool,
    bpm_min: Option<f32>,
    bpm_max: Option<f32>,
) -> bool {
    // Single-flight: only start if a scan is not already running.
    if state.running.swap(true, Ordering::SeqCst) {
        return false;
    }
    state.cancel.store(false, Ordering::SeqCst);
    // A previous run may have been cancelled while paused.
    state.paused.store(false, Ordering::SeqCst);
    state.done.store(0, Ordering::SeqCst);
    state.total.store(0, Ordering::SeqCst);
    set_scan_stage(&state, STAGE_ANALYZING);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let full = is_full_sweep(&paths, &dir);

    // A fresh full sweep means the library has (possibly) changed, so a cached
    // duplicate result is now invalid. A targeted run leaves it alone.
    if full {
        if let Ok(mut r) = app.state::<DedupeState>().result.lock() {
            *r = None;
        }
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _running = ScanRunningGuard(app.clone());
        let paths = paths.unwrap_or_else(|| {
            let mut found = Vec::new();
            collect_audio_files(std::path::Path::new(&dir), &mut found);
            found
        });
        let total = paths.len();
        app.state::<ScanState>().total.store(total, Ordering::SeqCst);
        emit_progress(&app, generation, 0, total, true, STAGE_ANALYZING);

        // Phase 1: audio properties, compatibility and existing tags.
        //
        // Two things keep this cheap on a library that was scanned before: a
        // file whose mtime and size still match its stored row is served from
        // the database instead of being probed again, and the probes that do
        // run go out PROBE_CONCURRENCY at a time. A probe costs ~100 ms, a stat
        // costs microseconds, so a sweep over an unchanged library is bound by
        // the directory walk rather than by ffprobe. `force` skips the cache
        // for a deliberate deep rescan.
        let cached = if force {
            std::collections::HashMap::new()
        } else {
            load_track_cache(&app, &dir)
        };
        let mut out: Vec<TrackAnalysis> = Vec::with_capacity(total);
        // Freshly probed tracks have to be written; cache hits are already in
        // the database unchanged, so they are only streamed to the UI. Writing
        // them back would mean thousands of identical UPDATEs per sweep.
        let mut fresh: Vec<TrackRecord> = Vec::with_capacity(SCAN_BATCH);
        let mut reused: Vec<TrackAnalysis> = Vec::with_capacity(SCAN_BATCH);
        let mut cancelled = false;
        let mut done = 0usize;
        // How many files this run actually (re-)analyzed — the duplicate phase
        // below only needs to run when the library really changed.
        let mut analyzed = 0usize;

        for chunk in paths.chunks(PROBE_CONCURRENCY) {
            // Pause and cancel are both decided here, between chunks, so the
            // probes already running always finish and get persisted.
            if await_resume(&app).await {
                cancelled = true;
                break;
            }
            // Split the chunk before doing any work: cache hits are taken
            // straight from the stored row, only the misses are probed.
            let mut probes = Vec::new();
            for path in chunk {
                // Stat before probing, never after: if the file changes while
                // we read it, storing the older identity means the next scan
                // re-probes it. The other order would cache a stale analysis
                // under the new file state.
                let fs = db::fs_identity(path);
                match cached.get(path) {
                    Some(hit) if !db::needs_reanalysis(Some(hit.fs), fs) => {
                        reused.push(hit.track.clone());
                    }
                    _ => {
                        let app2 = app.clone();
                        let path2 = path.clone();
                        // The path travels with the handle so a task that dies
                        // outright can still be named below.
                        probes.push((
                            path.clone(),
                            tauri::async_runtime::spawn(async move {
                                match analyze_path(&app2, path2.clone()).await {
                                    Ok(track) => Some(TrackRecord { track, fs }),
                                    Err(e) => {
                                        record_skip(&app2, &path2, e.to_string());
                                        None
                                    }
                                }
                            }),
                        ));
                    }
                }
            }
            let before = fresh.len();
            for (path, handle) in probes {
                match handle.await {
                    Ok(Some(record)) => fresh.push(record),
                    // The analysis reported the reason itself.
                    Ok(None) => {}
                    Err(e) => record_skip(&app, &path, format!("analysis crashed: {e}")),
                }
            }

            done += chunk.len();
            // The delta, not the total: `fresh` is only emptied on a flush, so
            // adding its length every chunk counted the same records again.
            analyzed += fresh.len() - before;
            if fresh.len() + reused.len() >= SCAN_BATCH {
                flush_scan_batch(
                    &app,
                    generation,
                    &dir,
                    std::mem::take(&mut fresh),
                    std::mem::take(&mut reused),
                    &mut out,
                );
            }
            app.state::<ScanState>().done.store(done, Ordering::SeqCst);
            emit_progress(&app, generation, done, total, true, STAGE_ANALYZING);
        }
        if !fresh.is_empty() || !reused.is_empty() {
            flush_scan_batch(
                &app,
                generation,
                &dir,
                std::mem::take(&mut fresh),
                std::mem::take(&mut reused),
                &mut out,
            );
        }

        // A completed full sweep saw every file, so anything still in the
        // database for this folder is gone from disk. A targeted or cancelled
        // run has no such licence.
        let mut removed = 0usize;
        if full && !cancelled {
            let seen: Vec<String> = out.iter().map(|t| t.path.clone()).collect();
            match retain_scanned_tracks(&app, &dir, &seen) {
                Ok(n) => removed = n,
                Err(e) => events::error(
                    &app,
                    "library",
                    "Could not drop the tracks that are gone from disk",
                    Some(&e.to_string()),
                ),
            }
        }

        // Phase 2: BPM for the tracks that carry none. Far more expensive (a full
        // decode each), hence its own concurrent pass, progress stage and
        // per-chunk streaming.
        if !cancelled && analyze_bpm {
            let state = app.state::<ScanState>();
            state.done.store(0, Ordering::SeqCst);
            let stage_app = app.clone();
            let progress_app = app.clone();
            let emit_app = app.clone();
            let patch_app = app.clone();
            let bpm_dir = dir.clone();
            cancelled = detect_bpm_pass(
                &app,
                &mut out,
                force_bpm,
                tempo_config(bpm_min, bpm_max),
                move |label| {
                    set_scan_stage(&stage_app.state::<ScanState>(), label);
                },
                |done, total| {
                    let state = progress_app.state::<ScanState>();
                    state.done.store(done, Ordering::SeqCst);
                    state.total.store(total, Ordering::SeqCst);
                    // Read back rather than hardcoded: the pass decides whether
                    // it is doing tempo, key, or both, and the button says so.
                    let stage = scan_stage(&state);
                    emit_progress(&progress_app, generation, done, total, true, &stage);
                },
                move |patch| emit_patch(&patch_app, generation, patch),
                |updated| {
                    // Writing the tempo tag rewrote the file, so its identity
                    // changed. Re-stat before storing, otherwise every file the
                    // BPM pass touched would look modified to the next scan and
                    // be probed again for nothing.
                    let records: Vec<TrackRecord> = updated
                        .iter()
                        .map(|track| TrackRecord {
                            fs: db::fs_identity(&track.path),
                            track: track.clone(),
                        })
                        .collect();
                    persist_tracks(&emit_app, &bpm_dir, &records);
                },
                || app.state::<ScanState>().cancel.load(Ordering::SeqCst),
            )
            .await;
        }

        // Phase 3: duplicates. Part of the scan rather than a button of its
        // own — with fingerprints cached, a repeat search costs comparison only,
        // so there is nothing left for a manual trigger to save.
        if dedupe_after_scan(full, cancelled, analyzed > 0 || removed > 0) {
            let state = app.state::<ScanState>();
            set_scan_stage(&state, STAGE_DUPLICATES);
            state.done.store(0, Ordering::SeqCst);
            state.total.store(0, Ordering::SeqCst);
            emit_progress(&app, generation, 0, 0, true, STAGE_DUPLICATES);
            cancelled = run_dedupe_phase(&app, &dir, generation).await;
        }

        let state = app.state::<ScanState>();
        let stage = scan_stage(&state);
        let done = state.done.load(Ordering::SeqCst);
        let total = state.total.load(Ordering::SeqCst);
        state.running.store(false, Ordering::SeqCst);
        emit_progress(&app, generation, done, total, false, &stage);
        let _ = app.emit(
            "scan://done",
            ScanDone {
                generation,
                cancelled,
                full,
                tracks: out,
            },
        );
    });
    true
}

/// Should the duplicate phase run after this scan?
///
/// Whether the library root itself can be listed.
///
/// A root that cannot be read — renamed, moved, on an unmounted volume — is
/// recoverable state, not an empty library, and the difference matters because
/// the walk cannot tell them apart: it skips unreadable folders silently.
fn library_root_available(dir: &str) -> bool {
    std::fs::read_dir(dir).is_ok()
}

/// Whether a run counts as a full sweep, i.e. one that has seen the whole
/// folder and may therefore prune, invalidate the duplicate cache, and tell the
/// frontend to drop the tracks it did not report.
///
/// Only a run without an explicit path list qualifies, and only if the root
/// could actually be listed. Without that second half a renamed or unmounted
/// library folder walks to zero files, and the sweep concludes that every
/// single track was deleted — taking the rows, their fingerprints and the
/// identity every edit hangs off with it. A run that could not look degrades to
/// a targeted one instead, which changes nothing and leaves the library intact.
fn is_full_sweep(paths: &Option<Vec<String>>, dir: &str) -> bool {
    paths.is_none() && library_root_available(dir)
}

/// A full sweep always re-checks. A targeted run only does when it actually
/// changed the library: a BPM-only pass touches nothing the matching uses
/// (duration, name, metadata, audio), so re-running the search would spend
/// time to arrive at the groups already stored. A cancelled run never does —
/// its picture of the library is incomplete.
fn dedupe_after_scan(full: bool, cancelled: bool, changed: bool) -> bool {
    !cancelled && (full || changed)
}

/// Projects stored tracks onto duplicate-search candidates.
///
/// The name is what the search compares when tags are missing, so it falls back
/// to the file name — an untagged file still has to take part in the search.
fn dup_candidates(tracks: &[TrackAnalysis]) -> Vec<DupCandidate> {
    tracks
        .iter()
        .map(|t| DupCandidate {
            id: t.id.clone(),
            path: t.path.clone(),
            name: t
                .metadata
                .title
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(&t.file_name)
                .to_string(),
            codec: t.audio.codec.clone(),
            container: t.audio.container.clone(),
            sample_rate: t.audio.sample_rate,
            bits_per_sample: t.audio.bits_per_sample,
            lossless: t.audio.lossless,
            duration_secs: t.audio.duration_secs,
            compatible: t.compat.compatible,
            title: t.metadata.title.clone(),
            artist: t.metadata.artist.clone(),
            album_artist: t.metadata.album_artist.clone(),
            album: t.metadata.album.clone(),
        })
        .collect()
}

/// Reads the scan cache for `dir`, or an empty one if the database is
/// unavailable. A missing cache only costs a re-probe, so it must never be the
/// reason a scan refuses to run.
fn load_track_cache(
    app: &AppHandle,
    dir: &str,
) -> std::collections::HashMap<String, db::CachedTrack> {
    let result = db::require(app)
        .and_then(|database| {
            let conn = database.conn()?;
            Ok(db::load_track_cache(&conn, dir)?)
        });
    match result {
        Ok(cache) => cache,
        Err(e) => {
            events::warn(
                app,
                "scan",
                "Could not read the scan cache — every file will be probed again",
                Some(&e.to_string()),
            );
            std::collections::HashMap::new()
        }
    }
}

/// Writes a batch of analyzed tracks to the database.
///
/// Failures are logged rather than propagated: the tracks are already on their
/// way to the UI, and losing the cache is a slower next scan, not a broken one.
fn persist_tracks(app: &AppHandle, dir: &str, records: &[TrackRecord]) {
    let result = db::require(app).and_then(|database| {
        let mut conn = database.conn()?;
        Ok(db::upsert_tracks(&mut conn, dir, records)?)
    });
    if let Err(e) = result {
        events::error(
            app,
            "scan",
            &format!("Could not store {} analyzed track(s)", records.len()),
            Some(&e.to_string()),
        );
    }
}

/// Persists the freshly probed tracks, records the whole batch for the
/// completion event and streams it to the frontend — in that order, so a quit
/// right after the UI update cannot leave the database behind what the user just
/// saw. `reused` came out of the database unchanged and is not written back.
fn flush_scan_batch(
    app: &AppHandle,
    generation: u64,
    dir: &str,
    fresh: Vec<TrackRecord>,
    reused: Vec<TrackAnalysis>,
    out: &mut Vec<TrackAnalysis>,
) {
    persist_tracks(app, dir, &fresh);
    let mut tracks: Vec<TrackAnalysis> = fresh.into_iter().map(|r| r.track).collect();
    tracks.extend(reused);
    out.extend(tracks.iter().cloned());
    emit_tracks(app, generation, tracks);
}

/// Runs the duplicate search over the whole library and publishes the result.
///
/// Candidates come from the database rather than from what this run analyzed:
/// after the batch upserts it holds the complete picture, and a targeted run
/// that only touched a handful of files would otherwise compare them against
/// nothing. Returns true if it was cancelled.
async fn run_dedupe_phase(app: &AppHandle, dir: &str, generation: u64) -> bool {
    let candidates = match db::require(app).and_then(|database| {
        let conn = database.conn()?;
        Ok(dup_candidates(&db::load_tracks(&conn, dir)?))
    }) {
        Ok(c) => c,
        Err(e) => {
            events::error(
            app,
            "duplicates",
            "Could not read the library for the duplicate search",
            Some(&e.to_string()),
        );
            return false;
        }
    };

    {
        let state = app.state::<DedupeState>();
        if state.running.swap(true, Ordering::SeqCst) {
            return false; // a search is already in flight; leave it alone
        }
        state.cancel.store(false, Ordering::SeqCst);
        state.done.store(0, Ordering::SeqCst);
        state.total.store(0, Ordering::SeqCst);
    }

    let (groups, cancelled) = dedupe::find_duplicates(app, candidates, generation).await;

    let state = app.state::<DedupeState>();
    state.running.store(false, Ordering::SeqCst);
    if cancelled {
        let _ = app.emit(
            "dedupe://done",
            DedupeDone {
                generation,
                cancelled,
                groups: vec![],
            },
        );
        return true;
    }

    // Groups the user waved off stay gone. Without this the search — which now
    // runs with every scan — would hand every dismissal straight back.
    let groups = drop_dismissed(app, groups);
    *state.result.lock().unwrap() = Some(groups.clone());
    persist_duplicate_groups(app, &groups);
    let _ = app.emit(
        "dedupe://done",
        DedupeDone {
            generation,
            cancelled: false,
            groups,
        },
    );
    false
}

/// Removes groups the user dismissed. On a database error nothing is filtered —
/// showing a dismissed group again is a smaller failure than hiding a real one.
fn drop_dismissed(app: &AppHandle, groups: Vec<DuplicateGroup>) -> Vec<DuplicateGroup> {
    let dismissed = db::require(app).and_then(|database| {
        let conn = database.conn()?;
        Ok(db::load_dismissed(&conn)?)
    });
    match dismissed {
        Ok(ids) => groups.into_iter().filter(|g| !ids.contains(&g.id)).collect(),
        Err(e) => {
            events::warn(
                app,
                "duplicates",
                "Could not read the dismissed groups — they may be offered again",
                Some(&e.to_string()),
            );
            groups
        }
    }
}

/// Drops database rows of `dir` that the sweep did not see, i.e. files that are
/// gone from disk. Their cached fingerprints go with them (`ON DELETE CASCADE`).
fn retain_scanned_tracks(app: &AppHandle, dir: &str, seen: &[String]) -> AppResult<usize> {
    let database = db::require(app)?;
    let mut conn = database.conn()?;
    Ok(db::retain_tracks(&mut conn, dir, seen)?)
}

/// Stores the duplicate result. Serializing through JSON keeps the database
/// oblivious to the group shape, which is a display structure owned by the UI.
fn persist_duplicate_groups(app: &AppHandle, groups: &[DuplicateGroup]) {
    let result = db::require(app).and_then(|database| {
        let mut conn = database.conn()?;
        let values: Vec<serde_json::Value> = groups
            .iter()
            .filter_map(|g| serde_json::to_value(g).ok())
            .collect();
        Ok(db::save_duplicate_groups(&mut conn, &values)?)
    });
    if let Err(e) = result {
        events::warn(
            app,
            "duplicates",
            "Could not store the duplicate result — the next start searches again",
            Some(&e.to_string()),
        );
    }
}

// --- library database -------------------------------------------------------

/// The stored tracks of a library folder, shown before any scan runs.
#[tauri::command]
pub fn library_load(app: AppHandle, dir: String) -> AppResult<Vec<TrackAnalysis>> {
    let database = db::require(&app)?;
    let conn = database.conn()?;
    Ok(db::load_tracks(&conn, &dir)?)
}

/// Why the bundled ffmpeg/ffprobe cannot be used here, or `None` when they
/// work. Checked once at startup; the frontend asks for the verdict rather than
/// running its own test.
#[tauri::command]
pub fn sidecar_error(state: State<'_, crate::audio::sidecar::SidecarState>) -> Option<String> {
    state.0.lock().ok().and_then(|slot| slot.clone())
}

/// The event log, newest first, with how far the user has read.
#[tauri::command]
pub fn events_load(app: AppHandle) -> AppResult<EventLog> {
    let database = db::require(&app)?;
    let conn = database.conn()?;
    Ok(EventLog {
        events: db::load_events(&conn)?,
        seen_id: db::events_seen(&conn)?,
    })
}

/// Marks everything up to `id` as read, which is what clears the badge.
#[tauri::command]
pub fn events_mark_seen(app: AppHandle, id: i64) -> AppResult<()> {
    let database = db::require(&app)?;
    let conn = database.conn()?;
    Ok(db::mark_events_seen(&conn, id)?)
}

/// Empties the log.
#[tauri::command]
pub fn events_clear(app: AppHandle) -> AppResult<usize> {
    let database = db::require(&app)?;
    let conn = database.conn()?;
    Ok(db::clear_events(&conn)?)
}

/// Whether the library folder can be listed right now.
///
/// The frontend needs this to tell "the library is empty" apart from "the
/// folder is gone", which look identical in the track list — and only the
/// second one is offered a relocate.
#[tauri::command]
pub fn library_dir_available(dir: String) -> bool {
    library_root_available(&dir)
}

/// Re-points the library folder after it was renamed, moved or remounted, so
/// the stored tracks keep their identity — and with it their pending edits and
/// cached fingerprints — instead of being rediscovered as new files.
///
/// Never deletes: rows whose file is not under the new root stay exactly where
/// they are and are reported as skipped.
#[tauri::command]
pub fn library_relocate(
    app: AppHandle,
    old_dir: String,
    new_dir: String,
) -> AppResult<RelocateResult> {
    let database = db::require(&app)?;
    let mut conn = database.conn()?;
    Ok(db::relocate_tracks(&mut conn, &old_dir, &new_dir)?)
}

/// Forgets tracks by path. The scan prunes a full sweep on its own; this is for
/// files the frontend noticed had vanished.
#[tauri::command]
pub fn library_delete(app: AppHandle, paths: Vec<String>) -> AppResult<usize> {
    let database = db::require(&app)?;
    let mut conn = database.conn()?;
    Ok(db::delete_tracks(&mut conn, &paths)?)
}

/// All pending metadata edits, keyed by track path.
#[tauri::command]
pub fn edits_load(
    app: AppHandle,
) -> AppResult<std::collections::HashMap<String, serde_json::Value>> {
    let database = db::require(&app)?;
    let conn = database.conn()?;
    Ok(db::load_edits(&conn)?)
}

/// Stores one pending edit. Called per change, which is the point of the
/// database: a single row is written instead of the whole library.
#[tauri::command]
pub fn edit_set(app: AppHandle, path: String, edit: serde_json::Value) -> AppResult<()> {
    let database = db::require(&app)?;
    let conn = database.conn()?;
    Ok(db::set_edit(&conn, &path, &edit)?)
}

/// Drops pending edits (applied, or undone).
#[tauri::command]
pub fn edit_clear(app: AppHandle, paths: Vec<String>) -> AppResult<()> {
    let database = db::require(&app)?;
    let conn = database.conn()?;
    for path in &paths {
        db::clear_edit(&conn, path)?;
    }
    Ok(())
}

/// The last duplicate result.
#[tauri::command]
pub fn duplicates_load(app: AppHandle) -> AppResult<Vec<serde_json::Value>> {
    let database = db::require(&app)?;
    let conn = database.conn()?;
    Ok(db::load_duplicate_groups(&conn)?)
}

/// Records that the user waved off a group, so later searches skip it. Their
/// files stay untouched — this is a "not a duplicate" verdict, not a deletion.
#[tauri::command]
pub fn duplicates_dismiss(app: AppHandle, id: String) -> AppResult<()> {
    let database = db::require(&app)?;
    let conn = database.conn()?;
    Ok(db::dismiss_group(&conn, &id)?)
}

/// Replaces the stored duplicate result. The dedupe run stores its own output;
/// this is how the frontend writes back a pruned version.
#[tauri::command]
pub fn duplicates_save(app: AppHandle, groups: Vec<serde_json::Value>) -> AppResult<()> {
    let database = db::require(&app)?;
    let mut conn = database.conn()?;
    Ok(db::save_duplicate_groups(&mut conn, &groups)?)
}

/// Clears `ScanState::running` when it goes out of scope — including when the
/// scan task unwinds. Without this, one panic would leave the job flagged as
/// running forever, and the single-flight guard would then reject every later
/// scan until the app is restarted.
struct ScanRunningGuard(AppHandle);

impl Drop for ScanRunningGuard {
    fn drop(&mut self) {
        self.0
            .state::<ScanState>()
            .running
            .store(false, Ordering::SeqCst);
    }
}

fn emit_progress(
    app: &AppHandle,
    generation: u64,
    done: usize,
    total: usize,
    running: bool,
    stage: &str,
) {
    let _ = app.emit(
        "scan://progress",
        ScanProgress {
            generation,
            done,
            total,
            running,
            // Read here rather than passed in: every caller would have to
            // thread it through, and all of them mean the same thing by it.
            paused: app.state::<ScanState>().paused.load(Ordering::SeqCst),
            stage: stage.to_string(),
        },
    );
}

fn emit_tracks(app: &AppHandle, generation: u64, tracks: Vec<TrackAnalysis>) {
    if tracks.is_empty() {
        return;
    }
    let _ = app.emit("scan://tracks", ScanTracks { generation, tracks });
}

/// One finished analysis, on its way to the row it belongs to.
fn emit_patch(app: &AppHandle, generation: u64, patch: TrackPatch) {
    let _ = app.emit("scan://patch", ScanPatch { generation, patch });
}

/// Current scan status (for attaching to a running scan after a reload).
#[tauri::command]
pub fn scan_status(state: State<'_, ScanState>) -> ScanStatus {
    ScanStatus {
        running: state.running.load(Ordering::SeqCst),
        paused: state.paused.load(Ordering::SeqCst),
        generation: state.generation.load(Ordering::SeqCst),
        done: state.done.load(Ordering::SeqCst),
        total: state.total.load(Ordering::SeqCst),
        stage: scan_stage(&state),
    }
}

/// Reads the scan's current stage label (poisoned lock falls back to the first
/// stage rather than panicking a background job).
fn scan_stage(state: &ScanState) -> String {
    state
        .stage
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| STAGE_ANALYZING.to_string())
}

fn set_scan_stage(state: &ScanState, stage: &str) {
    if let Ok(mut s) = state.stage.lock() {
        *s = stage.to_string();
    }
}

/// How long a paused run sleeps between checks. Long enough that holding a scan
/// for an hour costs nothing, short enough that resuming feels immediate.
const PAUSE_POLL_MS: u64 = 150;

/// Holds the run while it is paused, and reports whether it was cancelled.
///
/// Called immediately *before* the next unit of work is taken, never in the
/// middle of one: whatever is already in flight finishes and is persisted, so a
/// pause never costs a file its analysis. Cancelling while paused ends the run
/// rather than leaving it stuck — the flag is checked in the same loop.
pub(crate) async fn await_resume(app: &AppHandle) -> bool {
    loop {
        // Scoped so the state guard is gone before the await.
        let (paused, cancelled) = {
            let state = app.state::<ScanState>();
            (
                state.paused.load(Ordering::SeqCst),
                state.cancel.load(Ordering::SeqCst),
            )
        };
        if cancelled {
            return true;
        }
        if !paused {
            return false;
        }
        tokio::time::sleep(std::time::Duration::from_millis(PAUSE_POLL_MS)).await;
    }
}

/// Pauses or resumes the running scan.
///
/// Pausing a scan that is not running is a no-op rather than an error: the UI
/// can only offer it while one runs, and a stale click must not leave a flag
/// set that would hold the *next* run before it starts.
#[tauri::command]
pub fn set_scan_paused(app: AppHandle, state: State<'_, ScanState>, paused: bool) {
    if !state.running.load(Ordering::SeqCst) {
        state.paused.store(false, Ordering::SeqCst);
        return;
    }
    state.paused.store(paused, Ordering::SeqCst);
    // The counters have not moved, so nothing else would tell the UI.
    emit_progress(
        &app,
        state.generation.load(Ordering::SeqCst),
        state.done.load(Ordering::SeqCst),
        state.total.load(Ordering::SeqCst),
        true,
        &scan_stage(&state),
    );
}

/// Cancels a running scan (the task terminates at the next step).
#[tauri::command]
pub fn cancel_scan(app: AppHandle, state: State<'_, ScanState>) {
    // The duplicate search is a phase of the scan now, so cancelling the scan
    // has to reach it too.
    app.state::<DedupeState>()
        .cancel
        .store(true, Ordering::SeqCst);
    if state.running.load(Ordering::SeqCst) {
        state.cancel.store(true, Ordering::SeqCst);
        // Otherwise the run would sit in await_resume instead of ending.
        state.paused.store(false, Ordering::SeqCst);
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
///
/// The Discogs credentials are read here rather than passed in: they live in the
/// Keychain, and a secret that travels through the frontend on every request is
/// a secret the frontend holds. Without them — none stored, or a Keychain that
/// will not answer — the Discogs half is simply empty.
#[tauri::command]
pub async fn suggest_metadata(app: AppHandle, path: String) -> AppResult<MetadataSuggestions> {
    let (key, secret) = crate::secrets::discogs(&app).unwrap_or_default();
    suggest::suggest(&path, &key, &secret).await
}

/// Stores the Discogs consumer key and secret in the Keychain.
#[tauri::command]
pub fn set_discogs_credentials(app: AppHandle, key: String, secret: String) -> AppResult<()> {
    crate::secrets::set_discogs(&app, key.trim(), secret.trim())
        .map_err(|e| AppError::Metadata(format!("Keychain: {e}")))
}

/// Whether a Discogs credential is stored — never what it is, except for the
/// consumer key, which is not the secret half.
#[tauri::command]
pub fn discogs_credentials(app: AppHandle) -> crate::secrets::DiscogsStatus {
    crate::secrets::status(&app)
}

/// Removes the stored Discogs credentials.
#[tauri::command]
pub fn clear_discogs_credentials(app: AppHandle) -> AppResult<()> {
    crate::secrets::clear_discogs(&app).map_err(|e| AppError::Metadata(format!("Keychain: {e}")))
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
        // ffmpeg's muxers carry only a small subset of tags — the AIFF muxer
        // keeps little more than the title — so everything is re-applied with
        // lofty afterwards. Without the fallback to the source's own tags, a
        // plain conversion (no pending edit) silently drops artist, album,
        // label and BPM.
        let metadata = match &job.metadata {
            Some(md) => Some(md.clone()),
            None => read_metadata(&job.path).ok(),
        };

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
                    &metadata,
                    &cover,
                    // Convert keeps existing tags for fields left unset.
                    false,
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
                                // Remove the original if requested and the output
                                // is a different file (e.g. format change). It
                                // goes to the trash, not to `remove_file`: this
                                // is the user's own audio, and a conversion they
                                // did not mean has to be recoverable.
                                if options.replace_source
                                    && converted.output_path != job.path
                                {
                                    let _ = trash_ctx().delete(&job.path);
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
pub fn cancel_dedupe(app: AppHandle, state: State<'_, DedupeState>) {
    if state.running.load(Ordering::SeqCst) {
        state.cancel.store(true, Ordering::SeqCst);
        // The search is a phase of the scan, so it can be paused with it — and
        // a cancel has to be able to end a run that is currently held.
        app.state::<ScanState>()
            .paused
            .store(false, Ordering::SeqCst);
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

/// Outcome of writing one file's metadata (re-analyzed on success).
#[derive(Debug, serde::Serialize)]
pub struct WriteMetadataResult {
    pub path: String,
    pub track: Option<TrackAnalysis>,
    pub error: Option<String>,
}

/// Writes confirmed metadata (keeping/updating the cover) straight into the
/// files via lofty, then re-analyzes each so the caller can refresh the row
/// without a full rescan. Used by the metadata editor and bulk edit so tag
/// changes land on disk immediately — not only when a file is converted.
///
/// Unless `record_undo` is false, the files' current on-disk state is captured
/// first and stored as one undo entry, so the write can still be taken back
/// after a restart. Reading that state here rather than accepting it from the
/// caller is deliberate: the frontend only knows what it last displayed, while
/// this reads the tags that are actually in the file.
#[tauri::command]
pub async fn write_metadata(
    app: AppHandle,
    items: Vec<WriteMetadataItem>,
    record_undo: Option<bool>,
    label: Option<String>,
) -> Vec<WriteMetadataResult> {
    if record_undo.unwrap_or(true) {
        let snapshot = capture_undo(&items);
        if !snapshot.is_empty() {
            let label = label
                .unwrap_or_else(|| format!("{} track(s)", snapshot.len()));
            // A failed snapshot costs the undo, not the write the user asked for.
            if let Err(e) = store_undo(&app, &label, &snapshot) {
                events::warn(
                    &app,
                    "metadata",
                    "Could not record the undo entry — this write cannot be taken back",
                    Some(&e.to_string()),
                );
            }
        }
    }
    write_items(&app, items).await
}

/// Writes one batch of items, without touching the undo history.
async fn write_items(app: &AppHandle, items: Vec<WriteMetadataItem>) -> Vec<WriteMetadataResult> {
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let cover = item.cover.unwrap_or(CoverInput::Keep);
        // clear_empty = true: the caller sends the file's full intended tags, so
        // an empty field should clear the tag (enables a faithful undo).
        match write::finalize(&item.path, &item.path, &Some(item.metadata), &cover, true)
            .await
        {
            Ok(()) => {
                // The write itself worked; only the re-read for the refreshed
                // row can still fail, and then the row keeps its old values.
                let track = match analyze_path(app, item.path.clone()).await {
                    Ok(track) => Some(track),
                    Err(e) => {
                        record_skip(app, &item.path, format!("written, but could not be re-read: {e}"));
                        None
                    }
                };
                out.push(WriteMetadataResult {
                    path: item.path,
                    track,
                    error: None,
                });
            }
            Err(e) => out.push(WriteMetadataResult {
                path: item.path,
                track: None,
                error: Some(e.to_string()),
            }),
        }
    }
    out
}

/// Reads back what each file currently holds, as the write that would restore
/// it. Files that cannot be read are left out — there is nothing to restore
/// them to, and a batch must not lose its undo over one unreadable file.
fn capture_undo(items: &[WriteMetadataItem]) -> Vec<WriteMetadataItem> {
    items
        .iter()
        .filter_map(|item| {
            let metadata = read_metadata(&item.path).ok()?;
            Some(WriteMetadataItem {
                cover: Some(undo_cover(&item.path, item.cover.as_ref())),
                path: item.path.clone(),
                metadata,
            })
        })
        .collect()
}

/// The cover instruction that restores `path` after a write that does
/// `incoming` to it.
///
/// The bytes are only worth capturing when the write replaces artwork that is
/// already embedded — the metadata editor changing one track's cover, never a
/// bulk text edit, which is what keeps an undo entry small. `Keep` leaves an
/// embedded cover alone, so undoing with `Keep` restores it for free. Where
/// nothing is embedded, `None` is the faithful undo: it also takes back a cover
/// that `Keep` pulled in from a `cover.jpg` sitting next to the file.
fn undo_cover(path: &str, incoming: Option<&CoverInput>) -> CoverInput {
    undo_cover_for(incoming, write::read_cover_bytes(path))
}

/// The decision behind [`undo_cover`], separated from reading the file so it
/// can be tested without one.
fn undo_cover_for(incoming: Option<&CoverInput>, embedded: Option<Vec<u8>>) -> CoverInput {
    match (incoming.unwrap_or(&CoverInput::Keep), embedded) {
        (CoverInput::Keep, Some(_)) => CoverInput::Keep,
        (_, Some(bytes)) => CoverInput::Data {
            base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        },
        (_, None) => CoverInput::None,
    }
}

/// Persists one undo entry.
fn store_undo(app: &AppHandle, label: &str, items: &[WriteMetadataItem]) -> AppResult<()> {
    let database = db::require(app)?;
    let mut conn = database.conn()?;
    db::push_undo(&mut conn, label, items)?;
    Ok(())
}

/// The tag write that would be taken back next, for the undo button's label and
/// enabled state. `None` means there is nothing to undo.
#[tauri::command]
pub fn undo_peek(app: AppHandle) -> AppResult<Option<UndoEntry>> {
    let database = db::require(&app)?;
    let conn = database.conn()?;
    Ok(db::latest_undo(&conn)?)
}

/// Takes back the most recent tag write, restoring the files to the state
/// captured before it, and returns the re-analyzed tracks.
///
/// The entry is dropped only after the restoring write ran, and undoing is
/// itself not recorded — otherwise undo and redo would alternate forever.
#[tauri::command]
pub async fn undo_last(app: AppHandle) -> AppResult<Vec<WriteMetadataResult>> {
    let entry = {
        let database = db::require(&app)?;
        let conn = database.conn()?;
        db::latest_undo(&conn)?
    };
    let Some(entry) = entry else {
        return Ok(Vec::new());
    };
    let results = write_items(&app, entry.items).await;
    let database = db::require(&app)?;
    let conn = database.conn()?;
    db::drop_undo(&conn, entry.id)?;
    Ok(results)
}

/// Moves the given files to the trash (reversible, no Finder sound).
#[tauri::command]
pub async fn delete_files(app: AppHandle, paths: Vec<String>) -> Vec<DeleteResult> {
    let ctx = trash_ctx();
    let results: Vec<DeleteResult> = paths.into_iter().map(|p| trash_one(&ctx, p)).collect();
    forget_deleted(&app, &results);
    results
}

/// Deletes a whole album: if `dir` contains no audio outside `paths`, the entire
/// folder (incl. artwork and other side files) is trashed in one operation;
/// otherwise only the given files are trashed and the folder is left in place.
/// Either way the result reports one entry per track path so the caller can
/// update its state uniformly.
#[tauri::command]
pub async fn delete_album(app: AppHandle, dir: String, paths: Vec<String>) -> Vec<DeleteResult> {
    let ctx = trash_ctx();
    let results: Vec<DeleteResult> = if dir_holds_only(&dir, &paths) && ctx.delete(&dir).is_ok() {
        paths
            .into_iter()
            .map(|path| DeleteResult {
                path,
                success: true,
                error: None,
            })
            .collect()
    } else {
        // No folder trash, or it failed — trash the files individually.
        paths.into_iter().map(|p| trash_one(&ctx, p)).collect()
    };
    forget_deleted(&app, &results);
    results
}

/// Removes the rows of files that were actually trashed, so the library does
/// not keep serving them from the cache until the next full sweep. Their
/// fingerprints go with them via `ON DELETE CASCADE`.
fn forget_deleted(app: &AppHandle, results: &[DeleteResult]) {
    let gone: Vec<String> = results
        .iter()
        .filter(|r| r.success)
        .map(|r| r.path.clone())
        .collect();
    if gone.is_empty() {
        return;
    }
    let result = db::require(app).and_then(|database| {
        let mut conn = database.conn()?;
        Ok(db::delete_tracks(&mut conn, &gone)?)
    });
    if let Err(e) = result {
        events::warn(
            app,
            "library",
            &format!("Could not forget {} deleted track(s)", gone.len()),
            Some(&e.to_string()),
        );
    }
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
    use crate::models::TrackMetadata;
    use std::fs;

    /// What an undo has to put back for the cover, given what the write does.
    mod undo_cover {
        use super::*;

        fn cover() -> Option<Vec<u8>> {
            Some(vec![0xFF, 0xD8, 0xFF])
        }

        #[test]
        fn keep_over_an_embedded_cover_needs_no_bytes() {
            // `Keep` re-embeds what is already there, so restoring with `Keep`
            // restores it too — and stores nothing. This is the bulk-edit case,
            // and the reason an undo entry for 200 tracks stays small.
            let out = undo_cover_for(Some(&CoverInput::Keep), cover());
            assert!(matches!(out, CoverInput::Keep));
        }

        #[test]
        fn keep_without_an_embedded_cover_undoes_to_none() {
            // `Keep` falls back to a cover.jpg next to the file, so a write can
            // embed artwork into a file that had none. Undo has to take it off
            // again.
            let out = undo_cover_for(Some(&CoverInput::Keep), None);
            assert!(matches!(out, CoverInput::None));
        }

        #[test]
        fn a_replaced_cover_is_captured_as_bytes() {
            let out = undo_cover_for(
                Some(&CoverInput::File {
                    path: "/tmp/new.jpg".into(),
                }),
                cover(),
            );
            match out {
                CoverInput::Data { base64 } => assert_eq!(base64, "/9j/"),
                other => panic!("expected the previous cover, got {other:?}"),
            }
        }

        #[test]
        fn removing_a_cover_that_was_never_there_undoes_to_none() {
            let out = undo_cover_for(Some(&CoverInput::None), None);
            assert!(matches!(out, CoverInput::None));
        }

        #[test]
        fn an_unset_cover_is_treated_as_keep() {
            // `WriteMetadataItem::cover` defaults to None, which the write path
            // reads as `Keep` — the capture must agree with it.
            assert!(matches!(undo_cover_for(None, cover()), CoverInput::Keep));
            assert!(matches!(undo_cover_for(None, None), CoverInput::None));
        }
    }

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

    #[test]
    fn an_unreadable_library_root_is_not_an_empty_library() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        assert!(library_root_available(&root));

        // Gone (renamed, moved, unmounted) — and a file is not a folder either.
        assert!(!library_root_available(&format!("{root}/nope")));
        let file = dir.path().join("track.aiff");
        std::fs::write(&file, b"x").unwrap();
        assert!(!library_root_available(&file.to_string_lossy()));
    }

    #[test]
    fn a_run_that_could_not_look_is_never_a_full_sweep() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let gone = format!("{root}/moved-away");

        // The normal case: no path list and a readable root.
        assert!(is_full_sweep(&None, &root));
        // The dangerous one. A full sweep here would walk to zero files and
        // prune the whole library instead of reporting a missing folder.
        assert!(!is_full_sweep(&None, &gone));
        // An explicit path list is targeted either way.
        assert!(!is_full_sweep(&Some(vec!["/a.aiff".to_string()]), &root));
        assert!(!is_full_sweep(&Some(Vec::new()), &root));
    }

    #[test]
    fn dedupe_runs_after_a_full_sweep_or_a_change_but_never_after_a_cancel() {
        // A full sweep always re-checks.
        assert!(dedupe_after_scan(true, false, false));
        assert!(dedupe_after_scan(true, false, true));
        // A targeted run only when it changed something — a BPM-only pass
        // touches nothing the matching uses.
        assert!(dedupe_after_scan(false, false, true));
        assert!(!dedupe_after_scan(false, false, false));
        // A cancelled run has an incomplete picture of the library.
        assert!(!dedupe_after_scan(true, true, true));
        assert!(!dedupe_after_scan(false, true, true));
    }

    /// A bare row, for the patch tests: the fields a patch touches all start
    /// empty, everything else is beside the point here.
    fn blank_track(path: &str) -> TrackAnalysis {
        TrackAnalysis {
            id: path.into(),
            path: path.into(),
            file_name: "a.aiff".into(),
            audio: crate::models::AudioInfo {
                container: "aiff".into(),
                codec: "pcm_s16be".into(),
                sample_rate: 44100,
                bits_per_sample: 16,
                channels: 2,
                duration_secs: 210.5,
                lossless: true,
            },
            metadata: TrackMetadata::default(),
            compat: crate::models::CompatReport {
                compatible: true,
                issues: vec![],
            },
            metadata_incomplete: false,
            download_date: None,
            bpm_confidence: None,
            key: None,
            key_camelot: None,
            key_confidence: None,
        }
    }

    #[test]
    fn a_patch_rounds_the_tempo_to_what_a_tag_can_hold() {
        // The f32 -> f64 widening is what leaks 127.5999984741211 into the
        // database while the file says "127.60".
        let analysis = analysis::Analysis {
            tempo: Some(bpm::Tempo {
                bpm: 127.6,
                confidence: 0.8,
            }),
            ..Default::default()
        };
        let patch = patch_of("/lib/a.aiff", &analysis);
        assert_eq!(patch.bpm, Some(127.6));
        assert_eq!(patch.bpm_confidence, Some(0.8));
    }

    #[test]
    fn a_patch_carries_only_what_the_analysis_found() {
        // Key but no tempo is the normal state of a file another program tagged.
        let analysis = analysis::Analysis {
            key: Some(crate::audio::key::DetectedKey {
                key: crate::audio::key::MusicalKey::new(9, true),
                confidence: 0.6,
            }),
            ..Default::default()
        };
        let patch = patch_of("/lib/a.aiff", &analysis);
        assert_eq!(patch.key.as_deref(), Some("Am"));
        assert_eq!(patch.key_camelot.as_deref(), Some("8A"));
        assert!(patch.bpm.is_none());
        assert!(patch.bpm_confidence.is_none());
    }

    #[test]
    fn an_empty_analysis_has_nothing_to_report() {
        let patch = patch_of("/lib/a.aiff", &analysis::Analysis::default());
        assert!(patch.is_empty());
        assert!(!patch.changes_row());
    }

    #[test]
    fn a_waveform_alone_is_worth_emitting_but_not_worth_persisting() {
        // This is the case that reached the list not at all before: the waveform
        // lives in its own table, so the row has nothing new to write back — but
        // the row on screen still has something new to draw.
        let mut patch = patch_of("/lib/a.aiff", &analysis::Analysis::default());
        patch.waveform = true;
        assert!(!patch.is_empty());
        assert!(!patch.changes_row());
    }

    #[test]
    fn applying_a_patch_leaves_the_fields_it_does_not_carry_alone() {
        let mut track = blank_track("/lib/a.aiff");
        track.metadata.title = Some("Running".into());
        track.metadata.bpm = Some(120.0);

        // A key-only patch must not touch the tempo that is already there.
        let patch = TrackPatch {
            path: track.path.clone(),
            key: Some("Am".into()),
            key_camelot: Some("8A".into()),
            key_confidence: Some(0.6),
            ..Default::default()
        };
        apply_patch(&mut track, &patch);

        assert_eq!(track.key.as_deref(), Some("Am"));
        assert_eq!(track.metadata.bpm, Some(120.0));
        assert_eq!(track.metadata.title.as_deref(), Some("Running"));
    }

    #[test]
    fn a_waveform_only_patch_changes_no_field_of_the_row() {
        let mut track = blank_track("/lib/a.aiff");
        let before = track.clone();
        let patch = TrackPatch {
            path: track.path.clone(),
            waveform: true,
            ..Default::default()
        };
        apply_patch(&mut track, &patch);
        assert_eq!(track.metadata.bpm, before.metadata.bpm);
        assert_eq!(track.key, before.key);
    }

    #[test]
    fn dup_candidates_carry_the_fields_the_search_compares() {
        let track = TrackAnalysis {
            id: "/lib/a.aiff".into(),
            path: "/lib/a.aiff".into(),
            file_name: "a.aiff".into(),
            audio: crate::models::AudioInfo {
                container: "aiff".into(),
                codec: "pcm_s16be".into(),
                sample_rate: 44100,
                bits_per_sample: 16,
                channels: 2,
                duration_secs: 210.5,
                lossless: true,
            },
            metadata: TrackMetadata {
                title: Some("Running".into()),
                artist: Some("Monika".into()),
                album: Some("TD".into()),
                album_artist: Some("Monika".into()),
                ..Default::default()
            },
            compat: crate::models::CompatReport {
                compatible: true,
                issues: vec![],
            },
            metadata_incomplete: false,
            download_date: None,
            bpm_confidence: None,
            key: None,
            key_camelot: None,
            key_confidence: None,
        };

        let out = dup_candidates(std::slice::from_ref(&track));
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "Running");
        assert_eq!(out[0].duration_secs, 210.5);
        assert!(out[0].lossless);
        assert!(out[0].compatible);
        assert_eq!(out[0].artist.as_deref(), Some("Monika"));

        // No title, or a blank one: the file name has to stand in, otherwise an
        // untagged file could not take part in the search at all.
        let mut untitled = track.clone();
        untitled.metadata.title = None;
        assert_eq!(dup_candidates(&[untitled]).into_iter().next().unwrap().name, "a.aiff");
        let mut blank = track;
        blank.metadata.title = Some("   ".into());
        assert_eq!(dup_candidates(&[blank]).into_iter().next().unwrap().name, "a.aiff");

        assert!(dup_candidates(&[]).is_empty());
    }

    #[test]
    fn is_inside_accepts_only_real_descendants() {
        assert!(is_inside("/Users/me/Music", "/Users/me/Music/a.aiff"));
        assert!(is_inside("/Users/me/Music", "/Users/me/Music/sub/a.aiff"));
        // A trailing separator on the folder must not change the verdict.
        assert!(is_inside("/Users/me/Music/", "/Users/me/Music/a.aiff"));
        // A sibling folder that merely shares the prefix is not inside — this
        // is what keeps an imported file out of the library table.
        assert!(!is_inside("/Users/me/Music", "/Users/me/MusicOld/a.aiff"));
        assert!(!is_inside("/Users/me/Music", "/Users/me/Downloads/a.aiff"));
        // The folder itself is not a track in it.
        assert!(!is_inside("/Users/me/Music", "/Users/me/Music"));
        assert!(!is_inside("/Users/me/Music", ""));
    }

    /// `app.state::<Db>()` panics when the state was never managed, and
    /// `lib.rs` starts the app without a database on purpose when `Db::open`
    /// failed. A panic inside an async command task never settles the `invoke`
    /// promise, so the frontend waits forever instead of seeing an error — which
    /// is strictly worse than the empty library the design intends.
    ///
    /// Three helpers here used `app.state` directly and so turned a survivable
    /// start into a hung one. This asserts the shape rather than the behaviour,
    /// because building an `AppHandle` with unmanaged state in a unit test is
    /// not possible; `db::require` is the only correct way in.
    #[test]
    fn nothing_reaches_the_database_without_require() {
        let source = include_str!("commands.rs");
        // Assembled rather than written out, or this test would find itself.
        let forbidden = concat!("app.state", "::<db::Db>()");
        assert!(
            !source.contains(forbidden),
            "use db::require(app) instead: app.state panics when the database \
             failed to open, and the app is designed to run without one"
        );
    }
}
