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
use crate::models::{AudioInfo, TrackAnalysis, TrackMetadata, UndoEntry, WriteMetadataItem};

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
     genre, year, track_number, catalog_number, label, country, bpm, has_cover";

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
    let compat = compat::evaluate(&audio);
    let metadata_incomplete = !metadata.is_complete();
    Ok(TrackAnalysis {
        id: path.clone(),
        path,
        file_name: row.get(1)?,
        audio,
        metadata,
        compat,
        metadata_incomplete,
        download_date: row.get(2)?,
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
            mtime_ms: row.get(22)?,
            size_bytes: row.get(23)?,
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
                catalog_number, label, country, bpm, has_cover
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25
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
                has_cover = excluded.has_cover",
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
                bpm: Some(120),
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
        assert_eq!(t.metadata.bpm, Some(120));
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
        changed.track.metadata.bpm = Some(128);
        upsert_tracks(&mut conn, "/lib", &[changed]).unwrap();

        let loaded = load_tracks(&conn, "/lib").unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].metadata.bpm, Some(128));
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
