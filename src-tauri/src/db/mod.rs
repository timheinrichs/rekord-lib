//! SQLite storage for the library (tracks, edits, fingerprints, duplicates).
//!
//! Everything the library needs to remember lives here; the JSON store
//! (`tauri-plugin-store`) keeps only small config-shaped state — settings, the
//! Bandcamp session and the Bandcamp collection/download caches. The split is
//! deliberate: this database holds data that grows with the collection and is
//! written incrementally during a scan, which a store file rewritten in full on
//! every `save()` cannot do.

pub mod migrate;
pub mod schema;

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::audio::compat;
use crate::error::{AppError, AppResult};
use crate::models::{
    Playlist,
    AppEvent, AudioInfo, EventLevel, RelocateResult, TrackAnalysis, TrackMetadata, UndoEntry,
    WriteMetadataItem,
};

pub type DbResult<T> = Result<T, rusqlite::Error>;

/// File name of the database inside the app data directory.
pub const DB_FILE: &str = "rekord-lib.sqlite3";

/// The database as Tauri-managed state.
///
/// A single connection behind a mutex rather than a pool: SQLite takes one
/// writer at a time anyway, and every call site here is short and batched (one
/// transaction per scan batch), so the lock is never held across I/O-heavy work
/// like probing or decoding.
pub struct Db(pub Mutex<Connection>);

impl Db {
    /// Opens (or creates) the database at `dir/DB_FILE` and initializes the schema.
    pub fn open(dir: &Path) -> DbResult<Self> {
        let conn = Connection::open(dir.join(DB_FILE))?;
        schema::init(&conn)?;
        Ok(Db(Mutex::new(conn)))
    }

    /// In-memory database, for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> DbResult<Self> {
        let conn = Connection::open_in_memory()?;
        schema::init(&conn)?;
        Ok(Db(Mutex::new(conn)))
    }

    /// Locks the connection. A poisoned lock (a panic while a write was in
    /// flight) becomes an error rather than another panic, so one bad write
    /// cannot take down every later command.
    /// The connection, locked.
    ///
    /// **Nothing that reaches for the database again may run while this guard is
    /// alive.** It is a `std::sync::Mutex`, which is not reentrant, so a second
    /// `conn()` on the same thread deadlocks against the first — and a
    /// synchronous command does that on the thread the window is drawn on, so
    /// the app freezes with no error at all. `events::record` is the easy one to
    /// walk into: it stores what it logs. Scope the guard and let it go first.
    pub fn conn(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        self.0
            .lock()
            .map_err(|_| AppError::Db("database lock poisoned".into()))
    }
}

/// The database from managed state.
///
/// Startup keeps running when the database cannot be opened (see `lib.rs`), so
/// this is fallible by design: commands then report a readable error instead of
/// panicking on missing state.
pub fn require(app: &AppHandle) -> AppResult<State<'_, Db>> {
    app.try_state::<Db>()
        .ok_or_else(|| AppError::Db("the library database is unavailable".into()))
}

/// Filesystem identity of a file: what tells us whether a cached analysis is
/// still valid. Modification time plus size catches every practical edit
/// (re-tagging, re-encoding) without hashing the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FsIdentity {
    pub mtime_ms: i64,
    pub size_bytes: i64,
}

/// Reads the filesystem identity of `path`; `None` if it cannot be stat'ed
/// (deleted, permissions), which callers treat as "must re-analyze".
pub fn fs_identity(path: &str) -> Option<FsIdentity> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis() as i64;
    Some(FsIdentity {
        mtime_ms,
        size_bytes: meta.len() as i64,
    })
}

/// Does this file need a fresh analysis, or is the cached row still good?
///
/// Pure so the decision is testable without a filesystem. Anything unknown on
/// either side means yes: no cached row, an unreadable file, or a row imported
/// without an identity (see [`migrate`]) all re-analyze once.
pub fn needs_reanalysis(cached: Option<FsIdentity>, disk: Option<FsIdentity>) -> bool {
    match (cached, disk) {
        (Some(c), Some(d)) => c != d,
        _ => true,
    }
}

/// A track plus the filesystem identity it was analyzed at.
#[derive(Debug, Clone)]
pub struct TrackRecord {
    pub track: TrackAnalysis,
    pub fs: Option<FsIdentity>,
}

// --- schema_meta ------------------------------------------------------------

pub fn meta_get(conn: &Connection, key: &str) -> DbResult<Option<String>> {
    conn.query_row(
        "SELECT value FROM schema_meta WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
}

pub fn meta_set(conn: &Connection, key: &str, value: &str) -> DbResult<()> {
    conn.execute(
        "INSERT INTO schema_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

// --- tracks -----------------------------------------------------------------

/// Column list shared by the read paths, so they cannot drift apart.
const TRACK_COLUMNS: &str = "path, file_name, download_date, container, codec, sample_rate, \
     bits_per_sample, channels, duration_secs, lossless, title, artist, album, album_artist, \
     genre, year, track_number, catalog_number, label, country, bpm, has_cover, bpm_confidence, \
     music_key, key_confidence, bpm_absent_at, beat_offset_secs, beat_confidence, \
     grid_absent_at";

/// The version whose analysis produced what is in the rows. Used to stamp
/// `bpm_absent_at`, so a "listened, no tempo" mark expires with the detector
/// that set it.
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// How many columns [`TRACK_COLUMNS`] selects. Queries that append further
/// columns index them from here instead of from a hardcoded number — appending
/// `bpm_confidence` to the list above once shifted `mtime_ms` out from under
/// [`load_track_cache`], which read a confidence where an mtime should have been.
/// `track_columns_and_count_agree` keeps the two in step.
const TRACK_COLUMN_COUNT: usize = 29;

/// Rebuilds a [`TrackAnalysis`] from a row. `compat` and `metadata_incomplete`
/// are recomputed rather than read: they are derived values, and recomputing
/// them means a change to the compatibility rules takes effect immediately
/// instead of leaving stale verdicts in the database.
fn row_to_track(row: &rusqlite::Row) -> DbResult<TrackAnalysis> {
    let path: String = row.get(0)?;
    let audio = AudioInfo {
        container: row.get(3)?,
        codec: row.get(4)?,
        sample_rate: row.get(5)?,
        bits_per_sample: row.get(6)?,
        channels: row.get(7)?,
        duration_secs: row.get(8)?,
        lossless: row.get(9)?,
    };
    let metadata = TrackMetadata {
        title: row.get(10)?,
        artist: row.get(11)?,
        album: row.get(12)?,
        album_artist: row.get(13)?,
        genre: row.get(14)?,
        year: row.get(15)?,
        track_number: row.get(16)?,
        catalog_number: row.get(17)?,
        label: row.get(18)?,
        country: row.get(19)?,
        bpm: row.get(20)?,
        has_cover: row.get(21)?,
    };
    // Read as f64 and narrowed: rusqlite has no `FromSql` for `f32`, and the
    // column is REAL either way. The model keeps f32 because a 0..1 quality
    // value does not deserve eight bytes of precision.
    let bpm_confidence = row.get::<_, Option<f64>>(22)?.map(|v| v as f32);
    let key: Option<String> = row.get(23)?;
    let key_confidence = row.get::<_, Option<f64>>(24)?.map(|v| v as f32);
    // Derived, not stored — the same treatment `compat` gets, so a change to
    // the wheel takes effect on read instead of leaving stale values in rows.
    let key_camelot = key
        .as_deref()
        .and_then(crate::audio::key::MusicalKey::parse)
        .map(|k| k.camelot_name());
    let compat = compat::evaluate(&audio);
    let metadata_incomplete = !metadata.is_complete();
    // Derived like the two above: what is stored is the version that looked, and
    // what the app asks is "did *this* version already look and find nothing".
    // A new release therefore gets one more attempt at every one of them,
    // without a migration and without a flag to clear.
    let bpm_absent = row.get::<_, Option<String>>(25)?.as_deref() == Some(APP_VERSION);
    let beat_offset_secs = row.get::<_, Option<f64>>(26)?.map(|v| v as f32);
    let beat_confidence = row.get::<_, Option<f64>>(27)?.map(|v| v as f32);
    // Same shape, same reason, one column along: "this version listened and
    // found no phase", so an ambient track is not decoded again at every start.
    let grid_absent = row.get::<_, Option<String>>(28)?.as_deref() == Some(APP_VERSION);
    Ok(TrackAnalysis {
        id: path.clone(),
        path,
        file_name: row.get(1)?,
        audio,
        metadata,
        compat,
        metadata_incomplete,
        download_date: row.get(2)?,
        bpm_confidence,
        key,
        key_camelot,
        key_confidence,
        bpm_absent,
        beat_offset_secs,
        beat_confidence,
        grid_absent,
    })
}

/// All tracks of one library folder, ordered by path for a stable list.
pub fn load_tracks(conn: &Connection, library_dir: &str) -> DbResult<Vec<TrackAnalysis>> {
    let sql = format!(
        "SELECT {TRACK_COLUMNS} FROM tracks WHERE library_dir = ?1 ORDER BY path"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![library_dir], |row| row_to_track(row))?;
    rows.collect()
}

/// A cached analysis together with the file state it was produced from.
#[derive(Debug, Clone)]
pub struct CachedTrack {
    pub track: TrackAnalysis,
    pub fs: FsIdentity,
}

/// Everything the scan needs to decide what to skip: the stored analysis plus
/// the identity it was made at, keyed by path.
///
/// Rows without an identity are left out — they cannot be validated, so they
/// must be probed once (this is how rows imported from the legacy JSON store
/// without a readable file get refreshed).
pub fn load_track_cache(
    conn: &Connection,
    library_dir: &str,
) -> DbResult<HashMap<String, CachedTrack>> {
    let sql = format!(
        "SELECT {TRACK_COLUMNS}, mtime_ms, size_bytes FROM tracks
         WHERE library_dir = ?1 AND mtime_ms IS NOT NULL AND size_bytes IS NOT NULL"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![library_dir], |row| {
        let track = row_to_track(row)?;
        let fs = FsIdentity {
            mtime_ms: row.get(TRACK_COLUMN_COUNT)?,
            size_bytes: row.get(TRACK_COLUMN_COUNT + 1)?,
        };
        Ok((track.path.clone(), CachedTrack { track, fs }))
    })?;
    rows.collect()
}

/// Inserts or replaces tracks, in one transaction.
///
/// Keyed by path, which is also the track's id — re-analyzing a file overwrites
/// its row instead of accumulating duplicates.
pub fn upsert_tracks(
    conn: &mut Connection,
    library_dir: &str,
    records: &[TrackRecord],
) -> DbResult<()> {
    if records.is_empty() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO tracks (
                path, library_dir, file_name, mtime_ms, size_bytes, download_date,
                container, codec, sample_rate, bits_per_sample, channels, duration_secs, lossless,
                title, artist, album, album_artist, genre, year, track_number,
                catalog_number, label, country, bpm, has_cover, bpm_confidence,
                music_key, key_confidence, bpm_absent_at,
                beat_offset_secs, beat_confidence, grid_absent_at
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?29, ?30, ?31, ?32
             )
             ON CONFLICT(path) DO UPDATE SET
                library_dir = excluded.library_dir,
                file_name = excluded.file_name,
                mtime_ms = excluded.mtime_ms,
                size_bytes = excluded.size_bytes,
                download_date = excluded.download_date,
                container = excluded.container,
                codec = excluded.codec,
                sample_rate = excluded.sample_rate,
                bits_per_sample = excluded.bits_per_sample,
                channels = excluded.channels,
                duration_secs = excluded.duration_secs,
                lossless = excluded.lossless,
                title = excluded.title,
                artist = excluded.artist,
                album = excluded.album,
                album_artist = excluded.album_artist,
                genre = excluded.genre,
                year = excluded.year,
                track_number = excluded.track_number,
                catalog_number = excluded.catalog_number,
                label = excluded.label,
                country = excluded.country,
                bpm = excluded.bpm,
                has_cover = excluded.has_cover,
                bpm_confidence = excluded.bpm_confidence,
                music_key = excluded.music_key,
                key_confidence = excluded.key_confidence,
                bpm_absent_at = excluded.bpm_absent_at,
                beat_offset_secs = excluded.beat_offset_secs,
                beat_confidence = excluded.beat_confidence,
                grid_absent_at = excluded.grid_absent_at",
        )?;
        for rec in records {
            let t = &rec.track;
            stmt.execute(params![
                t.path,
                library_dir,
                t.file_name,
                rec.fs.map(|f| f.mtime_ms),
                rec.fs.map(|f| f.size_bytes),
                t.download_date,
                t.audio.container,
                t.audio.codec,
                t.audio.sample_rate,
                t.audio.bits_per_sample,
                t.audio.channels,
                t.audio.duration_secs,
                t.audio.lossless,
                t.metadata.title,
                t.metadata.artist,
                t.metadata.album,
                t.metadata.album_artist,
                t.metadata.genre,
                t.metadata.year,
                t.metadata.track_number,
                t.metadata.catalog_number,
                t.metadata.label,
                t.metadata.country,
                t.metadata.bpm,
                t.metadata.has_cover,
                t.bpm_confidence.map(|c| c as f64),
                t.key,
                t.key_confidence.map(|c| c as f64),
                // The stamp goes in only when this run actually looked and came
                // back empty; a row that found a tempo, or was never asked,
                // stores NULL and stays askable.
                t.bpm_absent.then_some(APP_VERSION),
                t.beat_offset_secs.map(|v| v as f64),
                t.beat_confidence.map(|v| v as f64),
                t.grid_absent.then_some(APP_VERSION),
            ])?;
        }
    }
    tx.commit()
}

/// Deletes tracks by path. Cascades to their cached fingerprints.
pub fn delete_tracks(conn: &mut Connection, paths: &[String]) -> DbResult<usize> {
    if paths.is_empty() {
        return Ok(0);
    }
    let tx = conn.transaction()?;
    let mut removed = 0;
    {
        let mut stmt = tx.prepare("DELETE FROM tracks WHERE path = ?1")?;
        for path in paths {
            removed += stmt.execute(params![path])?;
        }
    }
    tx.commit()?;
    Ok(removed)
}

/// The path `path` would have under `new_dir` instead of `old_dir`.
///
/// Returns `None` for anything that is not actually below `old_dir`, so a row
/// that was never part of that folder cannot be dragged along. Matching is on
/// the path prefix including the separator: `/music/lib-old` must not swallow
/// `/music/lib-older/track.aiff`.
fn relocated_path(path: &str, old_dir: &str, new_dir: &str) -> Option<String> {
    let old = old_dir.trim_end_matches('/');
    let rest = path.strip_prefix(old)?.strip_prefix('/')?;
    if rest.is_empty() {
        return None;
    }
    Some(format!("{}/{rest}", new_dir.trim_end_matches('/')))
}

/// Re-points a library folder: rewrites the stored paths of `old_dir` to
/// `new_dir` wherever the file is actually there, keeping track identity — and
/// with it the pending edits and cached fingerprints that hang off the path.
///
/// A row is only rewritten when the file exists under the new root and no row
/// for that path exists yet; everything else is counted as skipped and left
/// alone, because this runs precisely when the user is trying to recover data.
/// Foreign keys are deferred for the transaction: `fingerprints.path`,
/// `waveforms.path` and `playlist_items.path` all reference `tracks(path)`, so
/// updating the parent key would otherwise fail before the child rows can
/// follow. **Every one of them has to be listed here.** A child left behind
/// does not fail where it was forgotten — it fails at `COMMIT`, as a bare
/// `FOREIGN KEY constraint failed` that rolls the whole relocation back, in
/// exactly the situation this function exists to recover from. It has happened
/// twice: `playlist_items` in 0.8.0, and `waveforms` — which had been missing
/// since the table was added — in 0.8.1, where any user who had ever played a
/// track could not re-point their library at all.
///
/// `edits.path` is in the list too, but for the other reason: it has no foreign
/// key, so nothing carries it and nothing complains when it is forgotten.
pub fn relocate_tracks(
    conn: &mut Connection,
    old_dir: &str,
    new_dir: &str,
) -> DbResult<RelocateResult> {
    let rows: Vec<String> = {
        let mut stmt = conn.prepare("SELECT path FROM tracks WHERE library_dir = ?1")?;
        let paths = stmt.query_map(params![old_dir], |row| row.get::<_, String>(0))?;
        paths.collect::<DbResult<Vec<String>>>()?
    };

    let tx = conn.transaction()?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    let mut result = RelocateResult { moved: 0, skipped: 0 };
    {
        let mut taken = tx.prepare("SELECT 1 FROM tracks WHERE path = ?1")?;
        let mut move_track =
            tx.prepare("UPDATE tracks SET path = ?2, library_dir = ?3 WHERE path = ?1")?;
        let mut move_fingerprint = tx.prepare("UPDATE fingerprints SET path = ?2 WHERE path = ?1")?;
        let mut move_waveform = tx.prepare("UPDATE waveforms SET path = ?2 WHERE path = ?1")?;
        let mut move_edit = tx.prepare("UPDATE edits SET path = ?2 WHERE path = ?1")?;
        let mut move_member =
            tx.prepare("UPDATE playlist_items SET path = ?2 WHERE path = ?1")?;

        for old_path in &rows {
            let Some(new_path) = relocated_path(old_path, old_dir, new_dir) else {
                result.skipped += 1;
                continue;
            };
            if !Path::new(&new_path).is_file() || taken.exists(params![new_path])? {
                result.skipped += 1;
                continue;
            }
            move_track.execute(params![old_path, new_path, new_dir])?;
            move_fingerprint.execute(params![old_path, new_path])?;
            move_waveform.execute(params![old_path, new_path])?;
            move_edit.execute(params![old_path, new_path])?;
            move_member.execute(params![old_path, new_path])?;
            result.moved += 1;
        }
    }
    tx.commit()?;
    Ok(result)
}

/// Carries a track's row over to the file that replaced it, after a conversion
/// wrote a new file and sent the original to the trash.
///
/// **A replacing conversion is a move, not a delete and an add.** Without this
/// the old row was pruned by the next sweep and `playlist_items` cascaded away
/// with it, while the converted file arrived under a new path as a new row, in
/// no playlist — so "fix the sample rate on this whole set" emptied the set it
/// was run on. What moves is the identity: the path, the file name and the
/// playlist memberships.
///
/// **What deliberately does not move.**
/// - The pending `edits` row. This is the difference from [`relocate_tracks`],
///   which carries edits because nothing was applied to the file. A conversion
///   runs `metadata::write::finalize` over its output, so the edit *has* been
///   written into the file; carrying it would make an applied change reappear
///   as still pending.
/// - The cached `fingerprints` and `waveforms`. They are keyed by path *and* by
///   the file's mtime and size, and the converted file matches neither — a
///   carried-over row could never be read back, and it would describe audio
///   that is no longer there. Deleting them is also what keeps the deferred
///   foreign keys satisfied: they reference `tracks(path)`, which is being
///   rewritten under them.
///
/// The row keeps the old file's `mtime_ms`/`size_bytes`, so
/// [`needs_reanalysis`] sees the mismatch and the next scan re-probes the
/// track — which is right, because its container, sample rate and depth are
/// exactly what the conversion changed.
///
/// Where `new_path` already has a row — converting `a.wav` onto an `a.aiff`
/// the library already knows — the memberships move onto it and the old row is
/// deleted. A merge rather than the skip [`relocate_tracks`] performs, because
/// unlike a relocation the old file is genuinely gone.
///
/// Returns whether there was a row to carry over.
pub fn replace_track(conn: &mut Connection, old_path: &str, new_path: &str) -> DbResult<bool> {
    if old_path == new_path {
        return Ok(false);
    }
    let tx = conn.transaction()?;
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    let carried = {
        let mut exists = tx.prepare("SELECT 1 FROM tracks WHERE path = ?1")?;
        if !exists.exists(params![old_path])? {
            false
        } else {
            let taken = exists.exists(params![new_path])?;
            // `OR IGNORE` because `(playlist_id, path)` is the primary key: the
            // target may already sit in that playlist, and then the old row's
            // membership is the duplicate, not the survivor.
            tx.execute(
                "UPDATE OR IGNORE playlist_items SET path = ?2 WHERE path = ?1",
                params![old_path, new_path],
            )?;
            if taken {
                // Cascades: whatever memberships did not move, plus the caches.
                tx.execute("DELETE FROM tracks WHERE path = ?1", params![old_path])?;
            } else {
                let file_name = Path::new(new_path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| new_path.to_string());
                tx.execute(
                    "UPDATE tracks SET path = ?2, file_name = ?3 WHERE path = ?1",
                    params![old_path, new_path, file_name],
                )?;
            }
            true
        }
    };
    if carried {
        // `edits` has no foreign key to `tracks`, so nothing here happens on
        // its own — not in the merge branch either.
        tx.execute("DELETE FROM edits WHERE path = ?1", params![old_path])?;
        tx.execute("DELETE FROM fingerprints WHERE path = ?1", params![old_path])?;
        tx.execute("DELETE FROM waveforms WHERE path = ?1", params![old_path])?;
    }
    tx.commit()?;
    Ok(carried)
}

/// Drops every track of a library folder that is not in `keep`. Used by the
/// full sweep, which is the only run that has seen the whole folder and may
/// therefore conclude that a missing file is gone.
pub fn retain_tracks(conn: &mut Connection, library_dir: &str, keep: &[String]) -> DbResult<usize> {
    let known: std::collections::HashSet<&String> = keep.iter().collect();
    let existing: Vec<String> = {
        let mut stmt = conn.prepare("SELECT path FROM tracks WHERE library_dir = ?1")?;
        let rows = stmt.query_map(params![library_dir], |row| row.get::<_, String>(0))?;
        rows.collect::<DbResult<Vec<String>>>()?
    };
    let gone: Vec<String> = existing
        .into_iter()
        .filter(|p| !known.contains(p))
        .collect();
    delete_tracks(conn, &gone)
}

/// Invalidates every cached analysis when the app version changed.
///
/// The stored rows are only as good as the code that produced them: a new
/// version may probe more fields or read tags differently, and mtime/size
/// cannot see that. Dropping the identities (rather than the rows) keeps the
/// library visible while marking each file for exactly one re-probe.
///
/// "Changed" means changed *from a recorded version*. A database that has no
/// version yet was just created by the version now asking — a fresh install, or
/// the import in [`migrate`] — so its rows are current and must be left alone.
/// Invalidating them here would throw away the identities the import just
/// stat'ed and make the first sweep re-probe the whole library for nothing.
///
/// Returns how many rows were invalidated.
pub fn invalidate_on_version_change(conn: &Connection, version: &str) -> DbResult<usize> {
    let stored = meta_get(conn, schema::KEY_ANALYSIS_VERSION)?;
    if stored.as_deref() == Some(version) {
        return Ok(0);
    }
    if stored.is_none() {
        meta_set(conn, schema::KEY_ANALYSIS_VERSION, version)?;
        return Ok(0);
    }
    let affected = conn.execute(
        "UPDATE tracks SET mtime_ms = NULL, size_bytes = NULL
         WHERE mtime_ms IS NOT NULL OR size_bytes IS NOT NULL",
        [],
    )?;
    // Fingerprints depend on the audio content and ALGO_VERSION, not on the
    // app version, so they deliberately survive an update.
    meta_set(conn, schema::KEY_ANALYSIS_VERSION, version)?;
    Ok(affected)
}

// --- edits ------------------------------------------------------------------

/// Pending metadata edits, keyed by track path. The payload is the frontend's
/// `TrackEdit` as opaque JSON — the backend never needs to interpret it.
pub fn load_edits(conn: &Connection) -> DbResult<HashMap<String, Value>> {
    let mut stmt = conn.prepare("SELECT path, payload FROM edits")?;
    let rows = stmt.query_map([], |row| {
        let path: String = row.get(0)?;
        let raw: String = row.get(1)?;
        Ok((path, raw))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (path, raw) = row?;
        // A payload that no longer parses is dropped rather than failing the
        // whole load — one bad row must not cost the user every other edit.
        if let Ok(value) = serde_json::from_str(&raw) {
            out.insert(path, value);
        }
    }
    Ok(out)
}

pub fn set_edit(conn: &Connection, path: &str, payload: &Value) -> DbResult<()> {
    let raw = payload.to_string();
    conn.execute(
        "INSERT INTO edits (path, payload) VALUES (?1, ?2)
         ON CONFLICT(path) DO UPDATE SET payload = excluded.payload",
        params![path, raw],
    )?;
    Ok(())
}

pub fn clear_edit(conn: &Connection, path: &str) -> DbResult<()> {
    conn.execute("DELETE FROM edits WHERE path = ?1", params![path])?;
    Ok(())
}

// --- duplicate groups -------------------------------------------------------

/// The last duplicate result, as opaque JSON per group.
pub fn load_duplicate_groups(conn: &Connection) -> DbResult<Vec<Value>> {
    let mut stmt = conn.prepare("SELECT payload FROM duplicate_groups ORDER BY id")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    let mut out = Vec::new();
    for row in rows {
        if let Ok(value) = serde_json::from_str(&row?) {
            out.push(value);
        }
    }
    Ok(out)
}

/// Replaces the stored duplicate result. Groups are a derived cache, so a full
/// swap is both correct and simpler than diffing.
pub fn save_duplicate_groups(conn: &mut Connection, groups: &[Value]) -> DbResult<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM duplicate_groups", [])?;
    {
        let mut stmt = tx.prepare("INSERT INTO duplicate_groups (id, payload) VALUES (?1, ?2)")?;
        for group in groups {
            let id = group.get("id").and_then(|v| v.as_str()).unwrap_or("");
            if id.is_empty() {
                continue; // a group without an id cannot be keyed or pruned
            }
            stmt.execute(params![id, group.to_string()])?;
        }
    }
    tx.commit()
}

// --- dismissed groups ------------------------------------------------------

/// Groups the user waved off, so the search stops offering them.
///
/// This is what makes the automatic search usable: it runs with every scan, and
/// without a record of dismissals every waved-off group would come straight
/// back on the next run.
pub fn load_dismissed(conn: &Connection) -> DbResult<HashSet<String>> {
    let mut stmt = conn.prepare("SELECT id FROM dismissed_groups")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    rows.collect()
}

/// Records a dismissal. Dismissing the same group twice is not an error.
pub fn dismiss_group(conn: &Connection, id: &str) -> DbResult<()> {
    conn.execute(
        "INSERT INTO dismissed_groups (id) VALUES (?1) ON CONFLICT(id) DO NOTHING",
        params![id],
    )?;
    Ok(())
}

// --- event log --------------------------------------------------------------

/// How many events are kept. Enough that a scan over a large library still fits
/// with room to spare, few enough that the log stays a diagnostic record rather
/// than something that grows with the collection.
pub const MAX_EVENTS: usize = 500;

/// Key under which the newest event the user has already looked at is stored.
const KEY_EVENTS_SEEN: &str = "events_seen_id";

/// Appends an event and prunes the log back to [`MAX_EVENTS`].
pub fn push_event(
    conn: &mut Connection,
    level: EventLevel,
    source: &str,
    message: &str,
    detail: Option<&str>,
) -> DbResult<i64> {
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO events (created_ms, level, source, message, detail)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![now_ms(), level.as_str(), source, message, detail],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "DELETE FROM events WHERE id NOT IN
             (SELECT id FROM events ORDER BY id DESC LIMIT ?1)",
        params![MAX_EVENTS as i64],
    )?;
    tx.commit()?;
    Ok(id)
}

/// The log, newest first — the order the panel reads in.
pub fn load_events(conn: &Connection) -> DbResult<Vec<AppEvent>> {
    let mut stmt = conn.prepare(
        "SELECT id, created_ms, level, source, message, detail
         FROM events ORDER BY id DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(AppEvent {
            id: row.get(0)?,
            created_ms: row.get(1)?,
            level: EventLevel::from_str(&row.get::<_, String>(2)?),
            source: row.get(3)?,
            message: row.get(4)?,
            detail: row.get(5)?,
        })
    })?;
    rows.collect()
}

/// Empties the log, when the user has read it and wants a clean slate.
pub fn clear_events(conn: &Connection) -> DbResult<usize> {
    Ok(conn.execute("DELETE FROM events", [])?)
}

/// The newest event the user has already seen, or 0 for a log never opened.
/// Drives the badge, which is why it is stored next to the events rather than
/// in the settings: it is bookkeeping for this table, not a preference.
pub fn events_seen(conn: &Connection) -> DbResult<i64> {
    Ok(meta_get(conn, KEY_EVENTS_SEEN)?
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(0))
}

/// Marks everything up to `id` as seen. Never moves backwards: opening the
/// panel twice must not make older entries unread again.
pub fn mark_events_seen(conn: &Connection, id: i64) -> DbResult<()> {
    if id > events_seen(conn)? {
        meta_set(conn, KEY_EVENTS_SEEN, &id.to_string())?;
    }
    Ok(())
}

// --- undo history -----------------------------------------------------------

/// How many tag writes stay undoable. Deep enough to cover an evening of
/// editing, shallow enough that the covers captured along the way cannot grow
/// without bound.
pub const MAX_UNDO_ENTRIES: usize = 20;

/// Records the on-disk state a group of files was in before a tag write and
/// prunes the history back to [`MAX_UNDO_ENTRIES`]. Returns the new entry's id.
///
/// One row per group, not per file: the user undoes the edit they made, and a
/// bulk edit across 200 tracks was one edit.
pub fn push_undo(
    conn: &mut Connection,
    label: &str,
    items: &[WriteMetadataItem],
) -> DbResult<i64> {
    // Serialization of our own types cannot realistically fail, and an undo
    // entry is not worth failing the write it belongs to over.
    let payload = serde_json::to_string(items).unwrap_or_else(|_| "[]".to_string());
    let tx = conn.transaction()?;
    tx.execute(
        "INSERT INTO undo_entries (created_ms, label, payload) VALUES (?1, ?2, ?3)",
        params![now_ms(), label, payload],
    )?;
    let id = tx.last_insert_rowid();
    tx.execute(
        "DELETE FROM undo_entries WHERE id NOT IN
             (SELECT id FROM undo_entries ORDER BY id DESC LIMIT ?1)",
        params![MAX_UNDO_ENTRIES as i64],
    )?;
    tx.commit()?;
    Ok(id)
}

/// The most recent undoable write, or `None` when there is nothing to undo.
///
/// A row whose payload no longer parses is deleted and the search continues
/// with the one below it — a single unreadable entry must not sit at the top of
/// the stack and block the button forever.
pub fn latest_undo(conn: &Connection) -> DbResult<Option<UndoEntry>> {
    let mut stmt =
        conn.prepare("SELECT id, label, payload FROM undo_entries ORDER BY id DESC")?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (id, label, raw) = row?;
        match serde_json::from_str::<Vec<WriteMetadataItem>>(&raw) {
            Ok(items) if !items.is_empty() => return Ok(Some(UndoEntry { id, label, items })),
            // Empty or unreadable: nothing to restore from, so drop it.
            _ => {
                conn.execute("DELETE FROM undo_entries WHERE id = ?1", params![id])?;
            }
        }
    }
    Ok(None)
}

/// Removes one entry, once it has been applied.
pub fn drop_undo(conn: &Connection, id: i64) -> DbResult<usize> {
    conn.execute("DELETE FROM undo_entries WHERE id = ?1", params![id])
}

/// Wall-clock milliseconds. Only ever used for ordering and display, never for
/// cache validity, so a clock that jumps costs nothing here.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// --- playlists ---------------------------------------------------------------

/// Every playlist with its track count, newest name order last — the order the
/// user made them in, which is the only one the app has an opinion about.
pub fn load_playlists(conn: &Connection) -> DbResult<Vec<Playlist>> {
    let mut stmt = conn.prepare(
        "SELECT p.id, p.name, p.created_ms, p.updated_ms,
                (SELECT count(*) FROM playlist_items i WHERE i.playlist_id = p.id)
         FROM playlists p ORDER BY p.created_ms, p.id",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(Playlist {
            id: row.get(0)?,
            name: row.get(1)?,
            created_ms: row.get(2)?,
            updated_ms: row.get(3)?,
            track_count: row.get(4)?,
        })
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

/// Creates a playlist and returns its id.
pub fn create_playlist(conn: &Connection, name: &str) -> DbResult<i64> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO playlists (name, created_ms, updated_ms) VALUES (?1, ?2, ?3)",
        params![name, now, now],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_playlist(conn: &Connection, id: i64, name: &str) -> DbResult<usize> {
    Ok(conn.execute(
        "UPDATE playlists SET name = ?2, updated_ms = ?3 WHERE id = ?1",
        params![id, name, now_ms()],
    )?)
}

/// Deletes a playlist. Its membership rows go with it, by cascade.
pub fn delete_playlist(conn: &Connection, id: i64) -> DbResult<usize> {
    Ok(conn.execute("DELETE FROM playlists WHERE id = ?1", params![id])?)
}

/// Every playlist's contents at once, keyed by id — what the library table
/// needs to group by playlist without one query per group.
pub fn all_playlist_paths(conn: &Connection) -> DbResult<HashMap<i64, Vec<String>>> {
    let mut stmt = conn.prepare(
        "SELECT playlist_id, path FROM playlist_items ORDER BY playlist_id, position",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut out: HashMap<i64, Vec<String>> = HashMap::new();
    for row in rows {
        let (id, path) = row?;
        out.entry(id).or_default().push(path);
    }
    Ok(out)
}

/// Replaces a playlist's contents with exactly this list, in this order.
///
/// The whole list rather than a diff, deliberately. Order is the thing being
/// stored, every reorder rewrites most of the positions anyway, and a playlist
/// is tens or hundreds of rows — not the scale where a diff earns its
/// complexity. It also means the frontend's pure ordering logic
/// (`src/lib/playlists.ts`) is the only place that has to be right about what
/// the new order *is*.
/// Is this the one failure a playlist write is allowed to shrug off — a path
/// with no row in `tracks`? Anything else means the database could not do what
/// it was asked, and the caller has to hear about it.
fn is_missing_track(err: &rusqlite::Error) -> bool {
    matches!(
        err,
        rusqlite::Error::SqliteFailure(e, _)
            if e.code == rusqlite::ErrorCode::ConstraintViolation
                && e.extended_code == 787 // SQLITE_CONSTRAINT_FOREIGNKEY
    )
}

pub fn set_playlist_paths(conn: &mut Connection, id: i64, paths: &[String]) -> DbResult<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM playlist_items WHERE playlist_id = ?1", params![id])?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO playlist_items (playlist_id, path, position) VALUES (?1, ?2, ?3)",
        )?;
        for (position, path) in paths.iter().enumerate() {
            // A path the library no longer holds would violate the foreign key.
            // Skipped rather than failing the whole write: the list came from a
            // UI that may be a moment behind a delete, and losing the other
            // forty entries to that race would be the worse outcome.
            //
            // Only that one, though. `let _ =` here used to swallow a full
            // disk, a locked database and an I/O error alike — and since the
            // DELETE above has already run and the transaction still commits,
            // the caller was told the write had worked while the playlist had
            // been truncated. The reload that follows then makes the short list
            // the truth.
            match stmt.execute(params![id, path, position as i64]) {
                Ok(_) => {}
                Err(e) if is_missing_track(&e) => {}
                Err(e) => return Err(e),
            }
        }
    }
    tx.execute(
        "UPDATE playlists SET updated_ms = ?2 WHERE id = ?1",
        params![id, now_ms()],
    )?;
    tx.commit()
}

// --- fingerprints -----------------------------------------------------------

/// Encodes a fingerprint as little-endian `u32` bytes.
pub fn encode_fingerprint(fp: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(fp.len() * 4);
    for value in fp {
        out.extend_from_slice(&value.to_le_bytes());
    }
    out
}

/// Decodes a fingerprint blob; `None` if the length is not a multiple of 4.
pub fn decode_fingerprint(bytes: &[u8]) -> Option<Vec<u32>> {
    if bytes.len() % 4 != 0 {
        return None;
    }
    Some(
        bytes
            .chunks_exact(4)
            .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
            .collect(),
    )
}

/// Reads every cached fingerprint for `paths` in one query.
///
/// The per-file variant took the connection mutex once per candidate, which on a
/// library-sized run meant thousands of lock cycles for data that fits in one
/// statement. Validation of mtime/size happens in memory against `identities`,
/// so a stale entry is dropped here rather than by the query.
/// Stored waveforms for the given files, keyed by path.
///
/// Only entries whose file is unchanged and whose `algo_version` matches come
/// back: a waveform drawn from a file that has since been re-encoded would be a
/// picture of audio that is no longer there.
pub fn waveforms_load(
    conn: &Connection,
    identities: &HashMap<String, FsIdentity>,
    algo_version: i64,
) -> DbResult<HashMap<String, Vec<u8>>> {
    if identities.is_empty() {
        return Ok(HashMap::new());
    }
    let mut stmt = conn.prepare(
        "SELECT path, mtime_ms, size_bytes, data FROM waveforms WHERE algo_version = ?1",
    )?;
    let rows = stmt.query_map(params![algo_version], |row| {
        Ok((
            row.get::<_, String>(0)?,
            FsIdentity {
                mtime_ms: row.get(1)?,
                size_bytes: row.get(2)?,
            },
            row.get::<_, Vec<u8>>(3)?,
        ))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (path, stored, blob) = row?;
        if identities.get(&path) == Some(&stored) {
            out.insert(path, blob);
        }
    }
    Ok(out)
}

/// Stores one waveform, replacing whatever was there for that path.
pub fn waveform_save(
    conn: &Connection,
    path: &str,
    fs: FsIdentity,
    algo_version: i64,
    data: &[u8],
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO waveforms (path, mtime_ms, size_bytes, algo_version, data)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET
            mtime_ms = excluded.mtime_ms,
            size_bytes = excluded.size_bytes,
            algo_version = excluded.algo_version,
            data = excluded.data",
        params![path, fs.mtime_ms, fs.size_bytes, algo_version, data],
    )?;
    Ok(())
}

pub fn fingerprints_load(
    conn: &Connection,
    identities: &HashMap<String, FsIdentity>,
    algo_version: i64,
) -> DbResult<HashMap<String, Vec<u32>>> {
    if identities.is_empty() {
        return Ok(HashMap::new());
    }
    let mut stmt = conn.prepare(
        "SELECT path, mtime_ms, size_bytes, data FROM fingerprints WHERE algo_version = ?1",
    )?;
    let rows = stmt.query_map(params![algo_version], |row| {
        Ok((
            row.get::<_, String>(0)?,
            FsIdentity {
                mtime_ms: row.get(1)?,
                size_bytes: row.get(2)?,
            },
            row.get::<_, Vec<u8>>(3)?,
        ))
    })?;
    let mut out = HashMap::new();
    for row in rows {
        let (path, stored, blob) = row?;
        // Only keep entries we asked for whose file is unchanged.
        if identities.get(&path) != Some(&stored) {
            continue;
        }
        if let Some(fp) = decode_fingerprint(&blob) {
            out.insert(path, fp);
        }
    }
    Ok(out)
}

/// Stores a computed fingerprint.
pub fn fingerprint_put(
    conn: &Connection,
    path: &str,
    fs: FsIdentity,
    algo_version: i64,
    fp: &[u32],
) -> DbResult<()> {
    conn.execute(
        "INSERT INTO fingerprints (path, mtime_ms, size_bytes, algo_version, data)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(path) DO UPDATE SET
            mtime_ms = excluded.mtime_ms,
            size_bytes = excluded.size_bytes,
            algo_version = excluded.algo_version,
            data = excluded.data",
        params![
            path,
            fs.mtime_ms,
            fs.size_bytes,
            algo_version,
            encode_fingerprint(fp)
        ],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{CompatReport, TrackAnalysis};

    fn identity(mtime_ms: i64, size_bytes: i64) -> FsIdentity {
        FsIdentity {
            mtime_ms,
            size_bytes,
        }
    }

    #[test]
    fn track_columns_and_count_agree() {
        // The count is what keeps queries that append columns (load_track_cache)
        // pointing at the right ones. Add a column to TRACK_COLUMNS without
        // bumping this, and the failure is silent and wrong rather than loud.
        assert_eq!(
            TRACK_COLUMNS.split(',').count(),
            TRACK_COLUMN_COUNT,
            "TRACK_COLUMN_COUNT no longer matches TRACK_COLUMNS"
        );
    }

    fn track(path: &str) -> TrackAnalysis {
        TrackAnalysis {
            id: path.to_string(),
            path: path.to_string(),
            file_name: path.rsplit('/').next().unwrap_or(path).to_string(),
            audio: AudioInfo {
                container: "aiff".into(),
                codec: "pcm_s16be".into(),
                sample_rate: 44100,
                bits_per_sample: 16,
                channels: 2,
                duration_secs: 321.5,
                lossless: true,
            },
            metadata: TrackMetadata {
                title: Some("Running".into()),
                artist: Some("Monika Linges".into()),
                album: Some("TD4503".into()),
                album_artist: Some("Monika Linges".into()),
                genre: Some("Jazz".into()),
                year: Some("2024".into()),
                track_number: Some(1),
                catalog_number: Some("TD4503".into()),
                label: Some("Topic Drift".into()),
                country: None,
                bpm: Some(120.0),
                has_cover: true,
            },
            // Deliberately wrong on the way in: both derived fields must come
            // back recomputed, not as stored.
            compat: CompatReport {
                compatible: false,
                issues: vec![],
            },
            metadata_incomplete: true,
            download_date: Some(1_700_000_000_000),
            bpm_confidence: Some(0.62),
            key: Some("Am".into()),
            // Derived on read, so what a factory puts here is irrelevant — the
            // round-trip test asserts it comes back computed.
            key_camelot: None,
            key_confidence: Some(0.41),
            bpm_absent: false,
            grid_absent: false,
            beat_offset_secs: None,
            beat_confidence: None,
        }
    }

    /// One fingerprint through the production read path, so the tests exercise
    /// the same query the duplicate search uses.
    fn fp_of(
        conn: &Connection,
        path: &str,
        fs: FsIdentity,
        algo: i64,
    ) -> Option<Vec<u32>> {
        let mut want = HashMap::new();
        want.insert(path.to_string(), fs);
        fingerprints_load(conn, &want, algo)
            .unwrap()
            .remove(path)
    }

    fn record(path: &str, fs: Option<FsIdentity>) -> TrackRecord {
        TrackRecord {
            track: track(path),
            fs,
        }
    }

    mod playlists {
        use super::*;

        /// One playlist's contents, out of the call that reads them all —
        /// which is the only reader the app has, and so the only one worth
        /// keeping a function for.
        fn paths_of(conn: &Connection, id: i64) -> Vec<String> {
            all_playlist_paths(conn).unwrap().remove(&id).unwrap_or_default()
        }

        fn library(conn: &mut Connection, paths: &[&str]) {
            let records: Vec<TrackRecord> = paths
                .iter()
                .map(|p| record(p, Some(identity(1, 2))))
                .collect();
            upsert_tracks(conn, "/lib", &records).unwrap();
        }

        #[test]
        fn a_playlist_keeps_the_order_it_was_given() {
            // The whole reason membership is its own table: the order is stored,
            // not implied by whatever a query happens to return.
            let db = Db::open_in_memory().unwrap();
            let mut conn = db.0.lock().unwrap();
            library(&mut conn, &["/lib/a.aiff", "/lib/b.aiff", "/lib/c.aiff"]);

            let id = create_playlist(&conn, "Warmup").unwrap();
            let order = vec![
                "/lib/c.aiff".to_string(),
                "/lib/a.aiff".to_string(),
                "/lib/b.aiff".to_string(),
            ];
            set_playlist_paths(&mut conn, id, &order).unwrap();
            assert_eq!(paths_of(&conn, id), order);

            // And a reorder is just the new list.
            let reversed: Vec<String> = order.iter().rev().cloned().collect();
            set_playlist_paths(&mut conn, id, &reversed).unwrap();
            assert_eq!(paths_of(&conn, id), reversed);
        }

        #[test]
        fn deleting_a_track_takes_it_out_of_every_playlist() {
            // Otherwise the export would have to invent a track for a position
            // pointing at nothing.
            let db = Db::open_in_memory().unwrap();
            let mut conn = db.0.lock().unwrap();
            library(&mut conn, &["/lib/a.aiff", "/lib/b.aiff"]);
            let id = create_playlist(&conn, "Set").unwrap();
            set_playlist_paths(
                &mut conn,
                id,
                &["/lib/a.aiff".to_string(), "/lib/b.aiff".to_string()],
            )
            .unwrap();

            delete_tracks(&mut conn, &["/lib/a.aiff".to_string()]).unwrap();
            assert_eq!(paths_of(&conn, id), vec!["/lib/b.aiff"]);
        }

        #[test]
        fn deleting_a_playlist_takes_its_rows_and_leaves_the_tracks() {
            let db = Db::open_in_memory().unwrap();
            let mut conn = db.0.lock().unwrap();
            library(&mut conn, &["/lib/a.aiff"]);
            let id = create_playlist(&conn, "Gone").unwrap();
            set_playlist_paths(&mut conn, id, &["/lib/a.aiff".to_string()]).unwrap();

            delete_playlist(&conn, id).unwrap();
            assert!(load_playlists(&conn).unwrap().is_empty());
            assert!(paths_of(&conn, id).is_empty());
            assert_eq!(load_tracks(&conn, "/lib").unwrap().len(), 1, "the track stays");
        }

        #[test]
        fn a_path_the_library_no_longer_holds_is_dropped_rather_than_fatal() {
            // The list comes from a UI that can be a moment behind a delete.
            // Losing the other entries to that race would be the worse outcome.
            let db = Db::open_in_memory().unwrap();
            let mut conn = db.0.lock().unwrap();
            library(&mut conn, &["/lib/a.aiff"]);
            let id = create_playlist(&conn, "Set").unwrap();

            set_playlist_paths(
                &mut conn,
                id,
                &["/lib/a.aiff".to_string(), "/lib/ghost.aiff".to_string()],
            )
            .unwrap();
            assert_eq!(paths_of(&conn, id), vec!["/lib/a.aiff"]);
        }

        #[test]
        fn the_list_carries_a_count_and_survives_a_rename() {
            let db = Db::open_in_memory().unwrap();
            let mut conn = db.0.lock().unwrap();
            library(&mut conn, &["/lib/a.aiff", "/lib/b.aiff"]);
            let id = create_playlist(&conn, "Frist Draft").unwrap();
            set_playlist_paths(
                &mut conn,
                id,
                &["/lib/a.aiff".to_string(), "/lib/b.aiff".to_string()],
            )
            .unwrap();

            rename_playlist(&conn, id, "First Draft").unwrap();
            let all = load_playlists(&conn).unwrap();
            assert_eq!(all.len(), 1);
            assert_eq!(all[0].name, "First Draft");
            assert_eq!(all[0].track_count, 2);
        }

        #[test]
        fn every_playlist_can_be_read_in_one_go() {
            // What the table needs to group by playlist without one query per
            // group.
            let db = Db::open_in_memory().unwrap();
            let mut conn = db.0.lock().unwrap();
            library(&mut conn, &["/lib/a.aiff", "/lib/b.aiff"]);
            let one = create_playlist(&conn, "One").unwrap();
            let two = create_playlist(&conn, "Two").unwrap();
            set_playlist_paths(&mut conn, one, &["/lib/b.aiff".to_string()]).unwrap();
            set_playlist_paths(
                &mut conn,
                two,
                &["/lib/a.aiff".to_string(), "/lib/b.aiff".to_string()],
            )
            .unwrap();

            let all = all_playlist_paths(&conn).unwrap();
            assert_eq!(all[&one], vec!["/lib/b.aiff"]);
            assert_eq!(all[&two], vec!["/lib/a.aiff", "/lib/b.aiff"]);
        }
    }

    #[test]
    fn a_beat_grid_survives_the_round_trip() {
        // A period and a phase is the whole grid (B3), and it is stored so the
        // export can write a marker somebody can mix to. It used to be computed
        // and dropped on the floor.
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();

        let mut rec = record("/lib/a.aiff", Some(identity(1, 2)));
        rec.track.metadata.bpm = Some(128.0);
        rec.track.beat_offset_secs = Some(30.25);
        rec.track.beat_confidence = Some(0.72);
        upsert_tracks(&mut conn, "/lib", &[rec]).unwrap();

        let stored = &load_tracks(&conn, "/lib").unwrap()[0];
        assert_eq!(stored.beat_offset_secs, Some(30.25));
        assert_eq!(stored.beat_confidence, Some(0.72));
    }

    #[test]
    fn a_tempo_less_track_is_remembered_as_such_until_the_version_changes() {
        // The distinction the backlog needs: "no tempo yet" and "listened, and
        // there is none" are both `bpm IS NULL`, and without the second one an
        // interlude is re-analysed on every start forever (C9).
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();

        let mut rec = record("/lib/interlude.aiff", Some(identity(1, 2)));
        rec.track.metadata.bpm = None;
        rec.track.bpm_absent = true;
        upsert_tracks(&mut conn, "/lib", &[rec]).unwrap();

        let stored = load_tracks(&conn, "/lib").unwrap();
        assert_eq!(stored.len(), 1);
        assert!(stored[0].bpm_absent, "the mark did not survive the round trip");

        // The stamp is this version. Anything else reads as "not asked by the
        // detector that is running now", so a release gets one more attempt.
        conn.execute(
            "UPDATE tracks SET bpm_absent_at = '0.0.1-old'",
            [],
        )
        .unwrap();
        let stale = load_tracks(&conn, "/lib").unwrap();
        assert!(
            !stale[0].bpm_absent,
            "a mark from an older detector must not silence the file for good"
        );
    }

    #[test]
    fn a_playlist_write_forgives_a_missing_track_and_nothing_else() {
        // The one failure it may shrug off is a path the library no longer
        // holds — the list came from a UI a moment behind a delete. A real
        // error must not look the same, because the DELETE has already run:
        // reporting success there hands back a truncated playlist as the truth.
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", None)]).unwrap();
        let id = create_playlist(&conn, "Set").unwrap();

        set_playlist_paths(
            &mut conn,
            id,
            &["/lib/a.aiff".into(), "/lib/gone.aiff".into()],
        )
        .unwrap();
        assert_eq!(
            all_playlist_paths(&conn).unwrap().get(&id),
            Some(&vec!["/lib/a.aiff".to_string()])
        );

        // A duplicate violates the primary key, not the foreign key, so it is
        // an error the caller hears about rather than a row quietly dropped.
        let twice = set_playlist_paths(
            &mut conn,
            id,
            &["/lib/a.aiff".into(), "/lib/a.aiff".into()],
        );
        assert!(twice.is_err(), "a constraint that is not the FK must surface");
    }

    #[test]
    fn a_grid_that_cannot_be_found_is_remembered_the_same_way() {
        // Its own column rather than a shared one: this row has a tempo, so
        // `bpm_absent` is false and says nothing about the phase.
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();

        let mut rec = record("/lib/ambient.aiff", Some(identity(1, 2)));
        rec.track.metadata.bpm = Some(96.0);
        rec.track.beat_offset_secs = None;
        rec.track.grid_absent = true;
        upsert_tracks(&mut conn, "/lib", &[rec]).unwrap();

        let stored = load_tracks(&conn, "/lib").unwrap();
        assert!(stored[0].grid_absent, "the mark did not survive the round trip");
        assert!(!stored[0].bpm_absent, "the tempo was found; only the phase was not");

        conn.execute("UPDATE tracks SET grid_absent_at = '0.0.1-old'", [])
            .unwrap();
        let stale = load_tracks(&conn, "/lib").unwrap();
        assert!(
            !stale[0].grid_absent,
            "a better detector in a later release has to get its turn"
        );
    }

    #[test]
    fn finding_a_tempo_takes_the_mark_off_again() {
        // A forced re-detect that now does find something must not leave a row
        // claiming both a tempo and no tempo.
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();

        let mut rec = record("/lib/a.aiff", Some(identity(1, 2)));
        rec.track.bpm_absent = true;
        upsert_tracks(&mut conn, "/lib", &[rec.clone()]).unwrap();

        rec.track.bpm_absent = false;
        rec.track.metadata.bpm = Some(128.0);
        upsert_tracks(&mut conn, "/lib", &[rec]).unwrap();

        let stored = load_tracks(&conn, "/lib").unwrap();
        assert!(!stored[0].bpm_absent);
        assert_eq!(stored[0].metadata.bpm, Some(128.0));
    }

    #[test]
    fn init_is_idempotent() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        // A second init over the same connection must not fail or lose data.
        schema::init(&conn).unwrap();
        assert_eq!(
            meta_get(&conn, schema::KEY_SCHEMA_VERSION).unwrap(),
            Some(schema::SCHEMA_VERSION.to_string())
        );
    }

    #[test]
    fn track_roundtrip_recomputes_derived_fields() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", Some(identity(10, 20)))]).unwrap();

        let loaded = load_tracks(&conn, "/lib").unwrap();
        assert_eq!(loaded.len(), 1);
        let t = &loaded[0];
        assert_eq!(t.path, "/lib/a.aiff");
        assert_eq!(t.id, "/lib/a.aiff");
        assert_eq!(t.file_name, "a.aiff");
        assert_eq!(t.audio.sample_rate, 44100);
        assert!(t.audio.lossless);
        assert_eq!(t.metadata.bpm, Some(120.0));
        assert_eq!(t.metadata.label.as_deref(), Some("Topic Drift"));
        assert_eq!(t.metadata.country, None);
        assert_eq!(t.download_date, Some(1_700_000_000_000));
        // 44.1 kHz / 16-bit AIFF is compatible, and the metadata is complete —
        // both the opposite of what was written, proving they are derived.
        assert!(t.compat.compatible);
        assert!(!t.metadata_incomplete);
    }

    #[test]
    fn upsert_replaces_by_path_instead_of_duplicating() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", Some(identity(1, 2)))]).unwrap();

        let mut changed = record("/lib/a.aiff", Some(identity(99, 100)));
        changed.track.metadata.bpm = Some(128.0);
        upsert_tracks(&mut conn, "/lib", &[changed]).unwrap();

        let loaded = load_tracks(&conn, "/lib").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].metadata.bpm, Some(128.0));
        let cache = load_track_cache(&conn, "/lib").unwrap();
        assert_eq!(cache["/lib/a.aiff"].fs, identity(99, 100));
    }

    #[test]
    fn tracks_are_scoped_to_their_library_folder() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(&mut conn, "/one", &[record("/one/a.aiff", Some(identity(1, 1)))]).unwrap();
        upsert_tracks(&mut conn, "/two", &[record("/two/b.aiff", Some(identity(1, 1)))]).unwrap();

        assert_eq!(load_tracks(&conn, "/one").unwrap().len(), 1);
        assert_eq!(load_tracks(&conn, "/two").unwrap().len(), 1);
        assert!(load_tracks(&conn, "/three").unwrap().is_empty());
    }

    #[test]
    fn upsert_of_an_empty_batch_is_a_noop() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(&mut conn, "/lib", &[]).unwrap();
        assert!(load_tracks(&conn, "/lib").unwrap().is_empty());
    }

    #[test]
    fn cache_omits_rows_without_an_identity() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(
            &mut conn,
            "/lib",
            &[
                record("/lib/known.aiff", Some(identity(5, 6))),
                record("/lib/imported.aiff", None),
            ],
        )
        .unwrap();

        // Both are in the library …
        assert_eq!(load_tracks(&conn, "/lib").unwrap().len(), 2);
        // … but only the one that can be validated may be skipped by a scan.
        let cache = load_track_cache(&conn, "/lib").unwrap();
        assert_eq!(cache.len(), 1);
        assert!(cache.contains_key("/lib/known.aiff"));
    }

    #[test]
    fn delete_tracks_removes_rows_and_their_fingerprints() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let fs = identity(7, 8);
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", Some(fs))]).unwrap();
        fingerprint_put(&conn, "/lib/a.aiff", fs, 1, &[1, 2, 3]).unwrap();
        assert!(fp_of(&conn, "/lib/a.aiff", fs, 1).is_some());

        assert_eq!(delete_tracks(&mut conn, &["/lib/a.aiff".to_string()]).unwrap(), 1);
        assert!(load_tracks(&conn, "/lib").unwrap().is_empty());
        // ON DELETE CASCADE — which only works because the pragma is set.
        assert!(fp_of(&conn, "/lib/a.aiff", fs, 1).is_none());
    }

    #[test]
    fn delete_of_an_empty_list_is_a_noop() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", None)]).unwrap();
        assert_eq!(delete_tracks(&mut conn, &[]).unwrap(), 0);
        assert_eq!(load_tracks(&conn, "/lib").unwrap().len(), 1);
    }

    #[test]
    fn retain_drops_only_unseen_tracks_of_that_folder() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(
            &mut conn,
            "/lib",
            &[record("/lib/a.aiff", None), record("/lib/gone.aiff", None)],
        )
        .unwrap();
        upsert_tracks(&mut conn, "/other", &[record("/other/c.aiff", None)]).unwrap();

        let removed = retain_tracks(&mut conn, "/lib", &["/lib/a.aiff".to_string()]).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(load_tracks(&conn, "/lib").unwrap().len(), 1);
        // Another folder's rows are none of this sweep's business.
        assert_eq!(load_tracks(&conn, "/other").unwrap().len(), 1);
    }

    #[test]
    fn relocated_path_rewrites_only_real_descendants() {
        assert_eq!(
            relocated_path("/old/sub/a.aiff", "/old", "/new"),
            Some("/new/sub/a.aiff".to_string())
        );
        // A trailing slash on either root must not double up or drop a segment.
        assert_eq!(
            relocated_path("/old/a.aiff", "/old/", "/new/"),
            Some("/new/a.aiff".to_string())
        );
        // Prefix, but not a descendant — the separator is what decides.
        assert!(relocated_path("/old-archive/a.aiff", "/old", "/new").is_none());
        // The folder itself is not a track.
        assert!(relocated_path("/old", "/old", "/new").is_none());
        assert!(relocated_path("/elsewhere/a.aiff", "/old", "/new").is_none());
    }

    #[test]
    fn relocate_keeps_identity_including_edits_fingerprints_and_playlists() {
        let dir = tempfile::tempdir().unwrap();
        let new_root = dir.path().to_string_lossy().to_string();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/a.aiff"), b"x").unwrap();

        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let fs = identity(7, 8);
        upsert_tracks(&mut conn, "/old", &[record("/old/sub/a.aiff", Some(fs))]).unwrap();
        fingerprint_put(&conn, "/old/sub/a.aiff", fs, 1, &[1, 2, 3]).unwrap();
        // A waveform too: this table was the one child nobody listed, and a
        // test that seeds every *other* child is a test that says the
        // relocation works right up until a user has played something.
        waveform_save(&conn, "/old/sub/a.aiff", fs, 1, &[4, 5, 6]).unwrap();
        set_edit(&conn, "/old/sub/a.aiff", &serde_json::json!({"title": "x"})).unwrap();
        let list = create_playlist(&conn, "Set").unwrap();
        set_playlist_paths(&mut conn, list, &["/old/sub/a.aiff".to_string()]).unwrap();

        let result = relocate_tracks(&mut conn, "/old", &new_root).unwrap();
        assert_eq!(result, RelocateResult { moved: 1, skipped: 0 });

        // The row moved folders rather than being deleted and rediscovered …
        assert!(load_tracks(&conn, "/old").unwrap().is_empty());
        let moved = load_tracks(&conn, &new_root).unwrap();
        assert_eq!(moved.len(), 1);
        let new_path = format!("{new_root}/sub/a.aiff");
        assert_eq!(moved[0].path, new_path);
        // … so everything keyed by the path came along, which is the point.
        assert!(fp_of(&conn, &new_path, fs, 1).is_some());
        let mut want = HashMap::new();
        want.insert(new_path.clone(), fs);
        assert!(waveforms_load(&conn, &want, 1).unwrap().contains_key(&new_path));
        assert!(load_edits(&conn).unwrap().contains_key(&new_path));
        // A membership left pointing at the old path does not merely go
        // missing: the deferred foreign key turns it into a failed COMMIT, so
        // one playlist would have cost the user the whole relocation.
        assert_eq!(
            all_playlist_paths(&conn).unwrap().get(&list),
            Some(&vec![new_path])
        );
    }

    #[test]
    fn relocate_never_drops_what_it_cannot_find() {
        let dir = tempfile::tempdir().unwrap();
        let new_root = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("here.aiff"), b"x").unwrap();

        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(
            &mut conn,
            "/old",
            &[record("/old/here.aiff", None), record("/old/missing.aiff", None)],
        )
        .unwrap();

        let result = relocate_tracks(&mut conn, "/old", &new_root).unwrap();
        assert_eq!(result, RelocateResult { moved: 1, skipped: 1 });
        // The unfound row stays where it was; a later full sweep may prune it,
        // but a recovery attempt must not delete anything itself.
        let left = load_tracks(&conn, "/old").unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].path, "/old/missing.aiff");
    }

    #[test]
    fn relocate_skips_a_path_another_row_already_holds() {
        let dir = tempfile::tempdir().unwrap();
        let new_root = dir.path().to_string_lossy().to_string();
        std::fs::write(dir.path().join("a.aiff"), b"x").unwrap();
        let taken = format!("{new_root}/a.aiff");

        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        // The new folder was already scanned in its own right.
        upsert_tracks(&mut conn, &new_root, &[record(&taken, None)]).unwrap();
        upsert_tracks(&mut conn, "/old", &[record("/old/a.aiff", None)]).unwrap();

        let result = relocate_tracks(&mut conn, "/old", &new_root).unwrap();
        assert_eq!(result, RelocateResult { moved: 0, skipped: 1 });
        assert_eq!(load_tracks(&conn, &new_root).unwrap().len(), 1);
        assert_eq!(load_tracks(&conn, "/old").unwrap().len(), 1);
    }

    #[test]
    fn a_replacing_conversion_carries_the_row_and_its_playlists() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let fs = identity(7, 8);
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.wav", Some(fs))]).unwrap();
        fingerprint_put(&conn, "/lib/a.wav", fs, 1, &[1, 2, 3]).unwrap();
        waveform_save(&conn, "/lib/a.wav", fs, 1, &[9, 9]).unwrap();
        set_edit(&conn, "/lib/a.wav", &serde_json::json!({"title": "x"})).unwrap();
        // In two playlists, because that is a case 0.8.0 already had to fix
        // once: the row is one track, the memberships are two.
        let warmup = create_playlist(&conn, "Warmup").unwrap();
        let peak = create_playlist(&conn, "Peak").unwrap();
        set_playlist_paths(&mut conn, warmup, &["/lib/a.wav".to_string()]).unwrap();
        set_playlist_paths(&mut conn, peak, &["/lib/a.wav".to_string()]).unwrap();

        assert!(replace_track(&mut conn, "/lib/a.wav", "/lib/a.aiff").unwrap());

        // One row, at the new path, with the new name.
        let rows = load_tracks(&conn, "/lib").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "/lib/a.aiff");
        assert_eq!(rows[0].file_name, "a.aiff");
        // The memberships came along — the whole point of the move.
        let contents = all_playlist_paths(&conn).unwrap();
        assert_eq!(contents.get(&warmup), Some(&vec!["/lib/a.aiff".to_string()]));
        assert_eq!(contents.get(&peak), Some(&vec!["/lib/a.aiff".to_string()]));
        // The edit was written into the file by the conversion, so it is spent
        // rather than pending on the new path.
        assert!(load_edits(&conn).unwrap().is_empty());
        // And the caches describe audio that is no longer there.
        assert!(fp_of(&conn, "/lib/a.wav", fs, 1).is_none());
        assert!(fp_of(&conn, "/lib/a.aiff", fs, 1).is_none());
        let mut want = HashMap::new();
        want.insert("/lib/a.aiff".to_string(), fs);
        assert!(waveforms_load(&conn, &want, 1).unwrap().is_empty());
    }

    #[test]
    fn a_replacing_conversion_merges_onto_a_row_that_is_already_there() {
        // Converting `a.wav` onto an `a.aiff` the library already scanned. The
        // old file is genuinely gone, so this merges rather than skipping the
        // way a relocation does.
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(
            &mut conn,
            "/lib",
            &[record("/lib/a.wav", None), record("/lib/a.aiff", None)],
        )
        .unwrap();
        let list = create_playlist(&conn, "Set").unwrap();
        set_playlist_paths(&mut conn, list, &["/lib/a.wav".to_string()]).unwrap();

        assert!(replace_track(&mut conn, "/lib/a.wav", "/lib/a.aiff").unwrap());

        let rows = load_tracks(&conn, "/lib").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "/lib/a.aiff");
        assert_eq!(
            all_playlist_paths(&conn).unwrap().get(&list),
            Some(&vec!["/lib/a.aiff".to_string()])
        );
    }

    #[test]
    fn a_playlist_that_already_holds_the_output_keeps_one_entry() {
        // `(playlist_id, path)` is the primary key, so the membership that
        // moves is the duplicate — without `UPDATE OR IGNORE` this is a failed
        // write, not a merged one.
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(
            &mut conn,
            "/lib",
            &[record("/lib/a.wav", None), record("/lib/a.aiff", None)],
        )
        .unwrap();
        let list = create_playlist(&conn, "Set").unwrap();
        set_playlist_paths(
            &mut conn,
            list,
            &["/lib/a.aiff".to_string(), "/lib/a.wav".to_string()],
        )
        .unwrap();

        assert!(replace_track(&mut conn, "/lib/a.wav", "/lib/a.aiff").unwrap());

        assert_eq!(
            all_playlist_paths(&conn).unwrap().get(&list),
            Some(&vec!["/lib/a.aiff".to_string()])
        );
    }

    #[test]
    fn replacing_a_track_nothing_knows_about_changes_nothing() {
        // An import, or a conversion of a file the scan never reached: there is
        // no identity to carry, and inventing a row here would add a track the
        // library has not analysed.
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(&mut conn, "/lib", &[record("/lib/known.aiff", None)]).unwrap();

        assert!(!replace_track(&mut conn, "/elsewhere/x.wav", "/lib/x.aiff").unwrap());
        // An in-place conversion keeps its path and has nothing to move.
        assert!(!replace_track(&mut conn, "/lib/known.aiff", "/lib/known.aiff").unwrap());

        let rows = load_tracks(&conn, "/lib").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].path, "/lib/known.aiff");
    }

    #[test]
    fn needs_reanalysis_only_when_something_is_unknown_or_changed() {
        let fs = identity(100, 200);
        assert!(!needs_reanalysis(Some(fs), Some(fs)));
        assert!(needs_reanalysis(Some(fs), Some(identity(101, 200))));
        assert!(needs_reanalysis(Some(fs), Some(identity(100, 201))));
        // No cached row, or a file that cannot be stat'ed.
        assert!(needs_reanalysis(None, Some(fs)));
        assert!(needs_reanalysis(Some(fs), None));
        assert!(needs_reanalysis(None, None));
    }

    #[test]
    fn fingerprint_blob_roundtrips() {
        let fp = vec![0u32, 1, 0xDEAD_BEEF, u32::MAX];
        let bytes = encode_fingerprint(&fp);
        assert_eq!(bytes.len(), fp.len() * 4);
        assert_eq!(decode_fingerprint(&bytes), Some(fp));
        assert_eq!(decode_fingerprint(&[]), Some(vec![]));
        // A truncated blob is rejected rather than silently losing values.
        assert_eq!(decode_fingerprint(&[1, 2, 3]), None);
    }

    #[test]
    fn fingerprint_is_invalidated_by_content_or_algorithm_change() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let fs = identity(10, 1000);
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", Some(fs))]).unwrap();
        fingerprint_put(&conn, "/lib/a.aiff", fs, 1, &[7, 8, 9]).unwrap();

        assert_eq!(fp_of(&conn, "/lib/a.aiff", fs, 1), Some(vec![7, 8, 9]));
        // Re-tagged (mtime), re-encoded (size), or a new algorithm — all misses.
        assert!(fp_of(&conn, "/lib/a.aiff", identity(11, 1000), 1).is_none());
        assert!(fp_of(&conn, "/lib/a.aiff", identity(10, 1001), 1).is_none());
        assert!(fp_of(&conn, "/lib/a.aiff", fs, 2).is_none());
        // A path that was never fingerprinted.
        assert!(fp_of(&conn, "/lib/other.aiff", fs, 1).is_none());
    }

    #[test]
    fn fingerprint_put_overwrites_the_previous_entry() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", None)]).unwrap();
        fingerprint_put(&conn, "/lib/a.aiff", identity(1, 1), 1, &[1]).unwrap();
        fingerprint_put(&conn, "/lib/a.aiff", identity(2, 2), 1, &[2, 2]).unwrap();

        assert!(fp_of(&conn, "/lib/a.aiff", identity(1, 1), 1).is_none());
        assert_eq!(fp_of(&conn, "/lib/a.aiff", identity(2, 2), 1), Some(vec![2, 2]));
    }

    #[test]
    fn edits_are_stored_read_back_and_cleared_per_path() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        let edit = serde_json::json!({"metadata": {"title": "New"}, "cover": {"kind": "keep"}});
        set_edit(&conn, "/lib/a.aiff", &edit).unwrap();
        set_edit(&conn, "/lib/b.aiff", &edit).unwrap();

        let loaded = load_edits(&conn).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded["/lib/a.aiff"], edit);

        // Storing again replaces rather than duplicating.
        let changed = serde_json::json!({"metadata": {"title": "Newer"}});
        set_edit(&conn, "/lib/a.aiff", &changed).unwrap();
        assert_eq!(load_edits(&conn).unwrap()["/lib/a.aiff"], changed);

        clear_edit(&conn, "/lib/a.aiff").unwrap();
        let left = load_edits(&conn).unwrap();
        assert_eq!(left.len(), 1);
        assert!(left.contains_key("/lib/b.aiff"));
        // Clearing something that is not there is not an error.
        clear_edit(&conn, "/lib/nope.aiff").unwrap();
    }

    #[test]
    fn unparsable_edit_rows_are_skipped_not_fatal() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        set_edit(&conn, "/lib/good.aiff", &serde_json::json!({"ok": true})).unwrap();
        conn.execute(
            "INSERT INTO edits (path, payload) VALUES ('/lib/bad.aiff', 'not json')",
            [],
        )
        .unwrap();

        // One corrupt row must not cost the user every other pending edit.
        let loaded = load_edits(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert!(loaded.contains_key("/lib/good.aiff"));
    }

    #[test]
    fn duplicate_groups_are_replaced_wholesale_and_need_an_id() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let groups = vec![
            serde_json::json!({"id": "/lib/a.aiff", "files": [], "keep_id": "/lib/a.aiff"}),
            serde_json::json!({"id": "/lib/b.aiff", "files": [], "keep_id": "/lib/b.aiff"}),
            serde_json::json!({"files": []}), // no id — cannot be keyed, dropped
        ];
        save_duplicate_groups(&mut conn, &groups).unwrap();
        let loaded = load_duplicate_groups(&conn).unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0]["id"], "/lib/a.aiff");

        // A later run replaces the previous result instead of adding to it.
        save_duplicate_groups(&mut conn, &[serde_json::json!({"id": "/lib/c.aiff"})]).unwrap();
        let loaded = load_duplicate_groups(&conn).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0]["id"], "/lib/c.aiff");

        // An empty result clears the cache.
        save_duplicate_groups(&mut conn, &[]).unwrap();
        assert!(load_duplicate_groups(&conn).unwrap().is_empty());
    }

    #[test]
    fn version_change_invalidates_identities_but_keeps_tracks_and_fingerprints() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let fs = identity(42, 4242);
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", Some(fs))]).unwrap();
        fingerprint_put(&conn, "/lib/a.aiff", fs, 1, &[5, 5]).unwrap();

        // A database with no recorded version was just written by this very
        // version (fresh install, or the JSON import) — its rows are current.
        assert_eq!(invalidate_on_version_change(&conn, "0.4.8").unwrap(), 0);
        assert_eq!(load_track_cache(&conn, "/lib").unwrap().len(), 1);

        // Same version again: still nothing to do.
        assert_eq!(invalidate_on_version_change(&conn, "0.4.8").unwrap(), 0);

        // A genuinely different version invalidates.
        assert_eq!(invalidate_on_version_change(&conn, "0.4.9").unwrap(), 1);
        // The row survives, only its identity is gone -> exactly one re-probe.
        assert_eq!(load_tracks(&conn, "/lib").unwrap().len(), 1);
        assert!(load_track_cache(&conn, "/lib").unwrap().is_empty());
        // Fingerprints depend on the audio, not on the app version.
        assert_eq!(fp_of(&conn, "/lib/a.aiff", fs, 1), Some(vec![5, 5]));

        // A row re-analyzed under the new version stays cacheable.
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", Some(fs))]).unwrap();
        assert_eq!(invalidate_on_version_change(&conn, "0.4.9").unwrap(), 0);
        assert_eq!(load_track_cache(&conn, "/lib").unwrap().len(), 1);
    }

    #[test]
    fn a_fresh_database_records_its_version_without_invalidating() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", Some(identity(1, 2)))]).unwrap();
        // This is the case the runtime hit: import stats every file, and the
        // invalidation right after must not undo that work.
        assert_eq!(invalidate_on_version_change(&conn, "0.4.8").unwrap(), 0);
        assert_eq!(load_track_cache(&conn, "/lib").unwrap().len(), 1);
        assert_eq!(
            meta_get(&conn, schema::KEY_ANALYSIS_VERSION).unwrap(),
            Some("0.4.8".to_string())
        );
    }

    #[test]
    fn dismissed_groups_round_trip_and_tolerate_repeats() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        assert!(load_dismissed(&conn).unwrap().is_empty());

        dismiss_group(&conn, "/lib/a.aiff").unwrap();
        dismiss_group(&conn, "/lib/b.aiff").unwrap();
        // Dismissing twice must not fail — the UI cannot know what is stored.
        dismiss_group(&conn, "/lib/a.aiff").unwrap();

        let ids = load_dismissed(&conn).unwrap();
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("/lib/a.aiff"));
    }

    #[test]
    fn dismissals_are_independent_of_the_result_cache() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        dismiss_group(&conn, "/lib/a.aiff").unwrap();
        // The search overwrites its result on every run; a dismissal has to
        // outlive that, or the automatic search would resurrect it.
        save_duplicate_groups(&mut conn, &[serde_json::json!({"id": "/lib/a.aiff"})]).unwrap();
        save_duplicate_groups(&mut conn, &[]).unwrap();
        assert_eq!(load_dismissed(&conn).unwrap().len(), 1);
    }

    // --- undo history ------------------------------------------------------

    fn undo_item(path: &str, title: &str) -> WriteMetadataItem {
        WriteMetadataItem {
            path: path.to_string(),
            metadata: TrackMetadata {
                title: Some(title.to_string()),
                ..Default::default()
            },
            cover: Some(crate::models::CoverInput::Keep),
            cover_verbatim: false,
        }
    }

    #[test]
    fn an_undo_entry_comes_back_exactly_as_it_went_in() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();

        let items = vec![undo_item("/lib/a.aiff", "Before"), undo_item("/lib/b.aiff", "Also before")];
        let id = push_undo(&mut conn, "2 track(s)", &items).unwrap();

        let entry = latest_undo(&conn).unwrap().expect("an entry");
        assert_eq!(entry.id, id);
        assert_eq!(entry.label, "2 track(s)");
        assert_eq!(entry.items.len(), 2);
        assert_eq!(entry.items[0].path, "/lib/a.aiff");
        assert_eq!(entry.items[0].metadata.title.as_deref(), Some("Before"));
    }

    #[test]
    fn the_newest_write_is_the_one_undone_next() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();

        push_undo(&mut conn, "first", &[undo_item("/lib/a.aiff", "1")]).unwrap();
        push_undo(&mut conn, "second", &[undo_item("/lib/a.aiff", "2")]).unwrap();

        assert_eq!(latest_undo(&conn).unwrap().unwrap().label, "second");
    }

    #[test]
    fn dropping_an_entry_uncovers_the_one_below_it() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();

        push_undo(&mut conn, "first", &[undo_item("/lib/a.aiff", "1")]).unwrap();
        push_undo(&mut conn, "second", &[undo_item("/lib/a.aiff", "2")]).unwrap();

        let top = latest_undo(&conn).unwrap().unwrap();
        assert_eq!(drop_undo(&conn, top.id).unwrap(), 1);
        assert_eq!(latest_undo(&conn).unwrap().unwrap().label, "first");
    }

    #[test]
    fn the_history_stops_at_the_cap() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();

        for i in 0..MAX_UNDO_ENTRIES + 5 {
            push_undo(&mut conn, &format!("write {i}"), &[undo_item("/lib/a.aiff", "x")]).unwrap();
        }

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM undo_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count as usize, MAX_UNDO_ENTRIES);
        // The oldest went, not the newest.
        assert_eq!(
            latest_undo(&conn).unwrap().unwrap().label,
            format!("write {}", MAX_UNDO_ENTRIES + 4)
        );
    }

    #[test]
    fn an_unreadable_entry_is_dropped_instead_of_blocking_the_stack() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();

        push_undo(&mut conn, "good", &[undo_item("/lib/a.aiff", "1")]).unwrap();
        // A payload from some future shape of the type, sitting on top.
        conn.execute(
            "INSERT INTO undo_entries (created_ms, label, payload) VALUES (1, 'broken', '{oops')",
            [],
        )
        .unwrap();

        assert_eq!(latest_undo(&conn).unwrap().unwrap().label, "good");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM undo_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "the broken row must be gone, not skipped forever");
    }

    #[test]
    fn an_entry_without_items_is_not_offered() {
        let mut conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();

        push_undo(&mut conn, "nothing", &[]).unwrap();
        assert!(latest_undo(&conn).unwrap().is_none());
    }

    #[test]
    fn events_come_back_newest_first() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        push_event(&mut conn, EventLevel::Info, "scan", "started", None).unwrap();
        push_event(
            &mut conn,
            EventLevel::Error,
            "scan",
            "failed",
            Some("no space left"),
        )
        .unwrap();

        let events = load_events(&conn).unwrap();
        assert_eq!(events.len(), 2);
        // The panel reads top-down, so the newest belongs first.
        assert_eq!(events[0].message, "failed");
        assert_eq!(events[0].level, EventLevel::Error);
        assert_eq!(events[0].detail.as_deref(), Some("no space left"));
        assert_eq!(events[1].message, "started");
        assert!(events[1].detail.is_none());
    }

    #[test]
    fn the_log_stops_at_the_cap() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        for i in 0..(MAX_EVENTS + 5) {
            push_event(&mut conn, EventLevel::Info, "scan", &format!("event {i}"), None).unwrap();
        }

        let events = load_events(&conn).unwrap();
        assert_eq!(events.len(), MAX_EVENTS);
        // The oldest ones go, not the newest.
        assert_eq!(events[0].message, format!("event {}", MAX_EVENTS + 4));
    }

    #[test]
    fn an_unknown_level_reads_as_info_rather_than_alarming() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        push_event(&mut conn, EventLevel::Warn, "scan", "x", None).unwrap();
        conn.execute("UPDATE events SET level = 'catastrophe'", []).unwrap();

        assert_eq!(load_events(&conn).unwrap()[0].level, EventLevel::Info);
    }

    #[test]
    fn seen_marker_only_ever_moves_forward() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        // Nothing read yet, so every event counts as new.
        assert_eq!(events_seen(&conn).unwrap(), 0);

        mark_events_seen(&conn, 7).unwrap();
        assert_eq!(events_seen(&conn).unwrap(), 7);
        // Opening the panel again must not make older entries unread.
        mark_events_seen(&conn, 3).unwrap();
        assert_eq!(events_seen(&conn).unwrap(), 7);
    }

    #[test]
    fn clearing_empties_the_log() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        push_event(&mut conn, EventLevel::Warn, "scan", "x", None).unwrap();

        assert_eq!(clear_events(&conn).unwrap(), 1);
        assert!(load_events(&conn).unwrap().is_empty());
    }

    #[test]
    fn nothing_to_undo_on_a_fresh_database() {
        let conn = Connection::open_in_memory().unwrap();
        schema::init(&conn).unwrap();
        assert!(latest_undo(&conn).unwrap().is_none());
    }

    #[test]
    fn a_v2_database_gains_the_undo_table() {
        // Additive, like the dismissals table below: an older database picks it
        // up on the next start without a migration step.
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO schema_meta VALUES ('schema_version', '2');",
        )
        .unwrap();
        schema::init(&conn).unwrap();

        push_undo(&mut conn, "after upgrade", &[undo_item("/lib/a.aiff", "1")]).unwrap();
        assert_eq!(latest_undo(&conn).unwrap().unwrap().label, "after upgrade");
    }

    /// A v4 `tracks` table: `bpm INTEGER`, no `bpm_confidence`. Written out in
    /// full rather than generated, because the point of the migration tests is
    /// to run against the shape that is really out there on users' disks.
    fn create_v4_tracks(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO schema_meta VALUES ('schema_version', '4');
             CREATE TABLE tracks (
                path TEXT PRIMARY KEY, library_dir TEXT NOT NULL, file_name TEXT NOT NULL,
                mtime_ms INTEGER, size_bytes INTEGER, download_date INTEGER,
                container TEXT NOT NULL, codec TEXT NOT NULL, sample_rate INTEGER NOT NULL,
                bits_per_sample INTEGER NOT NULL, channels INTEGER NOT NULL,
                duration_secs REAL NOT NULL, lossless INTEGER NOT NULL,
                title TEXT, artist TEXT, album TEXT, album_artist TEXT, genre TEXT,
                year TEXT, track_number INTEGER, catalog_number TEXT, label TEXT,
                country TEXT, bpm INTEGER, has_cover INTEGER NOT NULL
             );
             CREATE INDEX tracks_library_dir ON tracks(library_dir);
             CREATE TABLE fingerprints (
                path TEXT PRIMARY KEY REFERENCES tracks(path) ON DELETE CASCADE,
                mtime_ms INTEGER NOT NULL, size_bytes INTEGER NOT NULL,
                algo_version INTEGER NOT NULL, data BLOB NOT NULL
             );
             INSERT INTO tracks VALUES (
                '/lib/a.aiff', '/lib', 'a.aiff', 42, 4242, NULL,
                'aiff', 'pcm_s16be', 44100, 16, 2, 210.5, 1,
                'Running', 'Monika', 'TD', 'Monika', NULL, NULL, NULL, NULL, NULL,
                NULL, 128, 1
             );
             INSERT INTO fingerprints VALUES ('/lib/a.aiff', 42, 4242, 1, x'0102');",
        )
        .unwrap();
    }

    #[test]
    fn the_v5_migration_keeps_the_tracks_and_their_fingerprints() {
        // The trap this guards: fingerprints.path cascades on delete, and the
        // migration drops the tracks table. With foreign keys left on, every
        // cached fingerprint in the library would go with it — silently, and
        // only noticed as a duplicate search that suddenly re-reads every file.
        let conn = Connection::open_in_memory().unwrap();
        create_v4_tracks(&conn);
        schema::init(&conn).unwrap();

        let tracks = load_tracks(&conn, "/lib").unwrap();
        assert_eq!(tracks.len(), 1, "the track itself must survive");
        assert_eq!(tracks[0].metadata.bpm, Some(128.0));
        assert_eq!(tracks[0].metadata.title.as_deref(), Some("Running"));
        assert_eq!(tracks[0].bpm_confidence, None, "v4 knew no confidence");

        let count: i64 = conn
            .query_row("SELECT count(*) FROM fingerprints", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "the fingerprint cache was cascaded away");

        // Enforcement has to be back on afterwards, or the rest of the session
        // runs without the cascade it relies on.
        let fk: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |r| r.get(0))
            .unwrap();
        assert_eq!(fk, 1, "foreign key enforcement was left off");
    }

    #[test]
    fn a_migrated_database_stores_fractional_tempos() {
        // The reason for the migration: an INTEGER-affinity column would have
        // taken 127.6 as well, but the declared type would have disagreed with
        // a fresh install's. This asserts the value, not the affinity.
        let mut conn = Connection::open_in_memory().unwrap();
        create_v4_tracks(&conn);
        schema::init(&conn).unwrap();

        let mut t = track("/lib/b.aiff");
        t.metadata.bpm = Some(127.6);
        t.bpm_confidence = Some(0.42);
        let rec = TrackRecord {
            track: t,
            fs: Some(identity(1, 2)),
        };
        upsert_tracks(&mut conn, "/lib", &[rec]).unwrap();

        let loaded = load_tracks(&conn, "/lib").unwrap();
        let b = loaded.iter().find(|t| t.path == "/lib/b.aiff").unwrap();
        assert_eq!(b.metadata.bpm, Some(127.6));
        assert_eq!(b.bpm_confidence, Some(0.42));
    }

    #[test]
    fn a_migrated_database_has_the_same_tracks_schema_as_a_fresh_one() {
        // Without this, the migration and SCHEMA_SQL drift apart the next time a
        // column is added, and only one of the two paths gets it.
        let migrated = Connection::open_in_memory().unwrap();
        create_v4_tracks(&migrated);
        schema::init(&migrated).unwrap();
        let fresh = Connection::open_in_memory().unwrap();
        schema::init(&fresh).unwrap();

        let describe = |conn: &Connection| -> Vec<(String, String, i64)> {
            let mut stmt = conn.prepare("PRAGMA table_info(tracks)").unwrap();
            let rows = stmt
                .query_map([], |r| {
                    Ok((r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))
                })
                .unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        assert_eq!(describe(&migrated), describe(&fresh));

        // The index goes with the dropped table, so the additive batch has to
        // put it back — otherwise every library listing turns into a table scan.
        let index: i64 = migrated
            .query_row(
                "SELECT count(*) FROM sqlite_master
                 WHERE type = 'index' AND name = 'tracks_library_dir'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(index, 1, "tracks_library_dir was not recreated");
    }

    #[test]
    fn the_v5_migration_looks_at_the_column_it_changes() {
        // The guard used to ask whether `bpm_confidence` existed, which is a
        // different question. A database whose recorded version was rolled back
        // for compatibility with an older build — leaving the later columns in
        // place — would then never get its INTEGER `bpm` widened again.
        let conn = Connection::open_in_memory().unwrap();
        create_v4_tracks(&conn);
        schema::init(&conn).unwrap();
        // Roll the version back and keep every column, as a compatibility fix
        // would, then put the old column type back.
        conn.execute_batch(
            "ALTER TABLE tracks RENAME TO tracks_old;
             CREATE TABLE tracks (path TEXT PRIMARY KEY, library_dir TEXT NOT NULL,
                file_name TEXT NOT NULL, mtime_ms INTEGER, size_bytes INTEGER,
                download_date INTEGER, container TEXT NOT NULL, codec TEXT NOT NULL,
                sample_rate INTEGER NOT NULL, bits_per_sample INTEGER NOT NULL,
                channels INTEGER NOT NULL, duration_secs REAL NOT NULL,
                lossless INTEGER NOT NULL, title TEXT, artist TEXT, album TEXT,
                album_artist TEXT, genre TEXT, year TEXT, track_number INTEGER,
                catalog_number TEXT, label TEXT, country TEXT, bpm INTEGER,
                has_cover INTEGER NOT NULL, bpm_confidence REAL, music_key TEXT,
                key_confidence REAL);
             DROP TABLE tracks_old;",
        )
        .unwrap();
        meta_set(&conn, schema::KEY_SCHEMA_VERSION, "4").unwrap();

        schema::init(&conn).unwrap();

        // The column was widened again, because the guard asks about the column.
        let ty: String = conn
            .query_row(
                "SELECT type FROM pragma_table_info('tracks') WHERE name = 'bpm'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ty.to_uppercase(), "REAL");
    }

    #[test]
    fn the_v5_migration_runs_only_once() {
        let conn = Connection::open_in_memory().unwrap();
        create_v4_tracks(&conn);
        schema::init(&conn).unwrap();
        // A second start must not rebuild again, and must not lose the row.
        schema::init(&conn).unwrap();
        schema::init(&conn).unwrap();
        assert_eq!(load_tracks(&conn, "/lib").unwrap().len(), 1);
        assert_eq!(
            meta_get(&conn, schema::KEY_SCHEMA_VERSION).unwrap(),
            Some(schema::SCHEMA_VERSION.to_string())
        );
    }

    /// Runs the migration over a **copy** of a real database, which is the only
    /// way to find out whether it survives data the tests never thought of.
    ///
    /// ```text
    /// REKORD_DB_COPY=/tmp/dbcheck \
    ///   cargo test --release --lib migrates_a_real_database -- --ignored --nocapture
    /// ```
    ///
    /// The directory must hold a copy of `rekord-lib.sqlite3` (plus its `-wal`,
    /// or recent writes are missing). Never point this at the live app data
    /// directory: it migrates in place.
    #[test]
    #[ignore = "needs a copy of a real database; set REKORD_DB_COPY"]
    fn migrates_a_real_database_copy() {
        let dir = std::env::var("REKORD_DB_COPY").expect("set REKORD_DB_COPY");
        let path = std::path::Path::new(&dir).join(DB_FILE);
        assert!(path.is_file(), "no database at {}", path.display());

        // Counts before, through a connection that does no migrating.
        let before = Connection::open(&path).unwrap();
        let count = |c: &Connection, sql: &str| -> i64 { c.query_row(sql, [], |r| r.get(0)).unwrap() };
        let tracks_before = count(&before, "SELECT count(*) FROM tracks");
        let fps_before = count(&before, "SELECT count(*) FROM fingerprints");
        let bpms_before = count(&before, "SELECT count(*) FROM tracks WHERE bpm IS NOT NULL");
        let version_before = meta_get(&before, schema::KEY_SCHEMA_VERSION).unwrap();
        drop(before);
        println!(
            "before: {tracks_before} tracks, {fps_before} fingerprints, \
             {bpms_before} with a tempo, schema {version_before:?}"
        );

        // Db::open runs schema::init, and with it the migration.
        let db = Db::open(std::path::Path::new(&dir)).unwrap();
        let conn = db.conn().unwrap();
        assert_eq!(count(&conn, "SELECT count(*) FROM tracks"), tracks_before);
        assert_eq!(count(&conn, "SELECT count(*) FROM fingerprints"), fps_before);
        assert_eq!(
            count(&conn, "SELECT count(*) FROM tracks WHERE bpm IS NOT NULL"),
            bpms_before
        );
        assert_eq!(
            meta_get(&conn, schema::KEY_SCHEMA_VERSION).unwrap(),
            Some(schema::SCHEMA_VERSION.to_string())
        );

        // And the rows still read back through the production path.
        let dirs: Vec<String> = {
            let mut stmt = conn.prepare("SELECT DISTINCT library_dir FROM tracks").unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.map(|r| r.unwrap()).collect()
        };
        let mut loaded = 0;
        for d in &dirs {
            loaded += load_tracks(&conn, d).unwrap().len();
            load_track_cache(&conn, d).unwrap();
        }
        println!("after: {loaded} tracks read back from {} folders", dirs.len());
        assert_eq!(loaded as i64, tracks_before);
    }

    #[test]
    fn a_v1_database_gains_the_dismissals_table() {
        // Every statement is CREATE … IF NOT EXISTS, so an older database picks
        // additive tables up on the next start without a migration step.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO schema_meta VALUES ('schema_version', '1');",
        )
        .unwrap();
        schema::init(&conn).unwrap();

        dismiss_group(&conn, "/lib/a.aiff").unwrap();
        assert_eq!(load_dismissed(&conn).unwrap().len(), 1);
        // Read from the constant, not a literal: a later bump adds tables the
        // same way, and this assertion is about the version being recorded.
        assert_eq!(
            meta_get(&conn, schema::KEY_SCHEMA_VERSION).unwrap(),
            Some(schema::SCHEMA_VERSION.to_string())
        );
    }

    #[test]
    fn a_waveform_survives_only_while_the_file_and_the_algorithm_match() {
        // The invalidation contract: a waveform drawn from audio that has since
        // been re-encoded is a picture of something else, and one drawn under
        // older rules does not match what the code now expects to unpack.
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let fs = identity(1, 100);
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", Some(fs))]).unwrap();
        waveform_save(&conn, "/lib/a.aiff", fs, 1, &[7, 8, 9, 10]).unwrap();

        let want = |id: FsIdentity| {
            let mut m = HashMap::new();
            m.insert("/lib/a.aiff".to_string(), id);
            m
        };
        // Unchanged file, same algorithm: served.
        assert_eq!(
            waveforms_load(&conn, &want(fs), 1).unwrap().get("/lib/a.aiff"),
            Some(&vec![7u8, 8, 9, 10])
        );
        // The file changed.
        assert!(waveforms_load(&conn, &want(identity(2, 100)), 1)
            .unwrap()
            .is_empty());
        assert!(waveforms_load(&conn, &want(identity(1, 999)), 1)
            .unwrap()
            .is_empty());
        // The algorithm changed.
        assert!(waveforms_load(&conn, &want(fs), 2).unwrap().is_empty());
        // Nothing asked for, nothing returned — not "everything".
        assert!(waveforms_load(&conn, &HashMap::new(), 1).unwrap().is_empty());
    }

    #[test]
    fn saving_a_waveform_twice_replaces_it() {
        // A re-analysis has to overwrite rather than fail on the primary key.
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let fs = identity(1, 100);
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", Some(fs))]).unwrap();
        waveform_save(&conn, "/lib/a.aiff", fs, 1, &[1, 2]).unwrap();
        let newer = identity(5, 500);
        waveform_save(&conn, "/lib/a.aiff", newer, 1, &[3, 4]).unwrap();

        let mut want = HashMap::new();
        want.insert("/lib/a.aiff".to_string(), newer);
        assert_eq!(
            waveforms_load(&conn, &want, 1).unwrap().get("/lib/a.aiff"),
            Some(&vec![3u8, 4])
        );
        let count: i64 = conn
            .query_row("SELECT count(*) FROM waveforms", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn forgetting_a_track_takes_its_waveform_with_it() {
        // Same cascade the fingerprints rely on: 4.8 KB per track adds up, and a
        // waveform for a path the library no longer knows can never be read.
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let fs = identity(1, 100);
        upsert_tracks(&mut conn, "/lib", &[record("/lib/a.aiff", Some(fs))]).unwrap();
        waveform_save(&conn, "/lib/a.aiff", fs, 1, &[1, 2]).unwrap();

        delete_tracks(&mut conn, &["/lib/a.aiff".to_string()]).unwrap();
        let count: i64 = conn
            .query_row("SELECT count(*) FROM waveforms", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0, "the waveform outlived its track");
    }

    #[test]
    fn fingerprints_load_returns_only_valid_entries() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let good = identity(1, 100);
        let stale = identity(2, 200);
        upsert_tracks(
            &mut conn,
            "/lib",
            &[
                record("/lib/good.aiff", Some(good)),
                record("/lib/stale.aiff", Some(stale)),
                record("/lib/none.aiff", None),
            ],
        )
        .unwrap();
        fingerprint_put(&conn, "/lib/good.aiff", good, 1, &[1, 2]).unwrap();
        fingerprint_put(&conn, "/lib/stale.aiff", stale, 1, &[3, 4]).unwrap();

        let mut want = HashMap::new();
        want.insert("/lib/good.aiff".to_string(), good);
        // The file changed since it was fingerprinted …
        want.insert("/lib/stale.aiff".to_string(), identity(99, 200));
        // … and this one was never fingerprinted at all.
        want.insert("/lib/none.aiff".to_string(), identity(5, 5));

        let found = fingerprints_load(&conn, &want, 1).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found["/lib/good.aiff"], vec![1, 2]);

        // A different algorithm version invalidates everything.
        assert!(fingerprints_load(&conn, &want, 2).unwrap().is_empty());
        // Asking for nothing costs no query and returns nothing.
        assert!(fingerprints_load(&conn, &HashMap::new(), 1)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn fingerprints_load_ignores_paths_that_were_not_asked_for() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let fs = identity(7, 7);
        upsert_tracks(
            &mut conn,
            "/lib",
            &[record("/lib/a.aiff", Some(fs)), record("/lib/b.aiff", Some(fs))],
        )
        .unwrap();
        fingerprint_put(&conn, "/lib/a.aiff", fs, 1, &[1]).unwrap();
        fingerprint_put(&conn, "/lib/b.aiff", fs, 1, &[2]).unwrap();

        let mut want = HashMap::new();
        want.insert("/lib/b.aiff".to_string(), fs);
        let found = fingerprints_load(&conn, &want, 1).unwrap();
        assert_eq!(found.len(), 1);
        assert!(found.contains_key("/lib/b.aiff"));
    }

    #[test]
    fn meta_set_overwrites_and_missing_keys_read_as_none() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        assert_eq!(meta_get(&conn, "nope").unwrap(), None);
        meta_set(&conn, "k", "1").unwrap();
        meta_set(&conn, "k", "2").unwrap();
        assert_eq!(meta_get(&conn, "k").unwrap(), Some("2".to_string()));
    }
}
