//! Schema definition and creation for the library database.
//!
//! The schema is created idempotently on every start (`CREATE TABLE IF NOT
//! EXISTS`), so a fresh install and an existing database take the same path.
//! Structural changes get a new `SCHEMA_VERSION` plus a step in
//! [`super::migrate`] — never an in-place edit of the statements below.

use rusqlite::Connection;

use super::DbResult;

/// Current schema version, stored in `schema_meta`.
///
/// Purely additive changes — a new table or index — need nothing beyond adding
/// them to [`SCHEMA_SQL`] and bumping this: every statement is
/// `CREATE … IF NOT EXISTS`, so an older database picks them up on the next
/// start. Only changes that transform or drop existing data need a step in
/// [`super::migrate`].
///
/// - 7: `waveforms`
/// - 6: `tracks.music_key`, `tracks.key_confidence`
/// - 5: `tracks.bpm` became `REAL`, `tracks.bpm_confidence` added
/// - 4: `events`
/// - 3: `undo_entries`
/// - 2: `dismissed_groups`
/// - 1: initial
pub const SCHEMA_VERSION: i64 = 7;

/// Key under which the schema version lives in `schema_meta`.
pub const KEY_SCHEMA_VERSION: &str = "schema_version";

/// Key that marks the one-time import from the legacy JSON store as done.
pub const KEY_MIGRATED_FROM_JSON: &str = "migrated_from_json";

/// Key holding the app version that produced the stored analyses.
pub const KEY_ANALYSIS_VERSION: &str = "analysis_version";

/// `compat` and `metadata_incomplete` are deliberately absent: both are pure
/// functions of the stored audio/metadata columns (`compat::evaluate`,
/// `TrackMetadata::is_complete`) and are recomputed on read. Storing them would
/// only create rows that disagree with the current compatibility rules.
const SCHEMA_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
    path            TEXT PRIMARY KEY,
    library_dir     TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    -- Filesystem identity used to decide whether a re-probe is needed.
    -- NULL means "unknown" (e.g. imported from the JSON store) and always
    -- counts as a cache miss.
    mtime_ms        INTEGER,
    size_bytes      INTEGER,
    download_date   INTEGER,
    -- AudioInfo
    container       TEXT NOT NULL,
    codec           TEXT NOT NULL,
    sample_rate     INTEGER NOT NULL,
    bits_per_sample INTEGER NOT NULL,
    channels        INTEGER NOT NULL,
    duration_secs   REAL NOT NULL,
    lossless        INTEGER NOT NULL,
    -- TrackMetadata
    title           TEXT,
    artist          TEXT,
    album           TEXT,
    album_artist    TEXT,
    genre           TEXT,
    year            TEXT,
    track_number    INTEGER,
    catalog_number  TEXT,
    label           TEXT,
    country         TEXT,
    -- REAL, not INTEGER: Rekordbox stores fractional tempos and so do we.
    bpm             REAL,
    -- How much the detector trusted its own answer (0..1). NULL where the BPM
    -- came from the file's tag instead of from analysis.
    bpm_confidence  REAL,
    has_cover       INTEGER NOT NULL,
    -- Detected key, as its name ("Am"). Only ever here: it is never written
    -- into the file, because the best detector available agrees with Rekordbox
    -- about a third of the time and a wrong TKEY outlives the guess. Camelot is
    -- derived on read, not stored.
    --
    -- Appended after `has_cover` on purpose: `ALTER TABLE ADD COLUMN` can only
    -- append, so a column added mid-list here would leave a migrated database
    -- with a different column order than a fresh one. Harmless for queries,
    -- which name their columns — but `a_migrated_database_has_the_same_tracks_schema_as_a_fresh_one`
    -- holds the stronger invariant, and it is worth holding. **New columns go
    -- at the end.**
    music_key       TEXT,
    key_confidence  REAL
);

CREATE INDEX IF NOT EXISTS tracks_library_dir ON tracks(library_dir);

CREATE TABLE IF NOT EXISTS fingerprints (
    path         TEXT PRIMARY KEY REFERENCES tracks(path) ON DELETE CASCADE,
    mtime_ms     INTEGER NOT NULL,
    size_bytes   INTEGER NOT NULL,
    algo_version INTEGER NOT NULL,
    data         BLOB NOT NULL
);

-- Waveform overviews, one row per track, ~4.8 KB each. Its own table rather
-- than columns on `tracks`: every query that lists the library would otherwise
-- carry 11 MB of blobs it does not need. Invalidated like a fingerprint —
-- mtime + size + the algorithm version that produced it.
CREATE TABLE IF NOT EXISTS waveforms (
    path         TEXT PRIMARY KEY REFERENCES tracks(path) ON DELETE CASCADE,
    mtime_ms     INTEGER NOT NULL,
    size_bytes   INTEGER NOT NULL,
    algo_version INTEGER NOT NULL,
    data         BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS edits (
    path    TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS duplicate_groups (
    id      TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);

-- Groups the user has waved off. Kept apart from `duplicate_groups` because
-- that table is a result cache the search overwrites on every run, while a
-- dismissal is a decision that has to outlive it.
CREATE TABLE IF NOT EXISTS dismissed_groups (
    id TEXT PRIMARY KEY
);

-- Undo history for tag writes. One row per group of files written together,
-- holding their on-disk state from immediately before the write, so a write can
-- still be taken back after a restart. The payload is a `Vec<WriteMetadataItem>`
-- as JSON — the same shape the write path consumes, because undoing a write is
-- itself a write.
-- What the app did and what failed, so a run can still be explained after the
-- toast is gone and the app has been restarted. Capped in `push_event`: it is a
-- diagnostic record, not an archive, and it must not grow with the library.
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_ms INTEGER NOT NULL,
    level      TEXT NOT NULL,
    source     TEXT NOT NULL,
    message    TEXT NOT NULL,
    -- The path, the raw error, whatever makes the message actionable.
    detail     TEXT
);

CREATE TABLE IF NOT EXISTS undo_entries (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_ms INTEGER NOT NULL,
    label      TEXT NOT NULL,
    payload    TEXT NOT NULL
);
"#;

/// Applies the connection-level pragmas. WAL keeps a long scan's writes from
/// blocking reads; `foreign_keys` is what makes the fingerprint cascade work
/// (SQLite has it off by default, per connection).
pub fn apply_pragmas(conn: &Connection) -> DbResult<()> {
    // journal_mode returns a row ("wal"), so it needs a query rather than execute.
    conn.query_row("PRAGMA journal_mode=WAL", [], |_| Ok(()))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    Ok(())
}

/// Creates the schema if needed and records the version. Safe to call repeatedly.
///
/// Order matters: transforming steps run *before* [`SCHEMA_SQL`], because that
/// batch is all `CREATE … IF NOT EXISTS` and would otherwise be a no-op over a
/// table a step has just rebuilt — and because rebuilding a table drops its
/// indexes, which the batch then recreates.
pub fn init(conn: &Connection) -> DbResult<()> {
    apply_pragmas(conn)?;
    let from = stored_version(conn)?;
    upgrade(conn, from)?;
    conn.execute_batch(SCHEMA_SQL)?;
    super::meta_set(conn, KEY_SCHEMA_VERSION, &SCHEMA_VERSION.to_string())?;
    Ok(())
}

/// The version recorded in the database, or `None` for one that has never been
/// initialised. A value that is present but unparseable counts as "very old",
/// so every step runs rather than none.
fn stored_version(conn: &Connection) -> DbResult<Option<i64>> {
    let exists: bool = conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
        [],
        |_| Ok(true),
    )
    .unwrap_or(false);
    if !exists {
        return Ok(None);
    }
    Ok(Some(
        super::meta_get(conn, KEY_SCHEMA_VERSION)?
            .and_then(|v| v.parse().ok())
            .unwrap_or(0),
    ))
}

/// Transforming migrations — the ones `CREATE … IF NOT EXISTS` cannot express.
/// A fresh database (`from == None`) needs none of them: [`SCHEMA_SQL`] already
/// describes the current shape.
fn upgrade(conn: &Connection, from: Option<i64>) -> DbResult<()> {
    let Some(from) = from else {
        return Ok(());
    };
    if from < 5 {
        widen_bpm_to_real(conn)?;
    }
    if from < 6 {
        // Purely additive, so no table rebuild and none of its hazards: the
        // `CREATE … IF NOT EXISTS` batch cannot add a column to a table that
        // already exists, but `ALTER TABLE` can.
        add_column(conn, "tracks", "music_key", "TEXT")?;
        add_column(conn, "tracks", "key_confidence", "REAL")?;
    }
    Ok(())
}

/// Rebuilds `tracks` so `bpm` is declared `REAL` and `bpm_confidence` exists.
///
/// SQLite cannot change a column's type in place, so this is the documented
/// create/copy/drop/rename dance. Two things about it are easy to get wrong:
///
/// - **Foreign keys have to be off.** `fingerprints.path` references
///   `tracks(path)` with `ON DELETE CASCADE`, and `apply_pragmas` turns
///   enforcement on — so dropping the old table would take every cached
///   fingerprint with it. The pragma cannot change inside a transaction, hence
///   the explicit off/commit/on order below.
/// - **It has to be idempotent.** A crash between the drop and the rename would
///   otherwise leave a database no later start can repair.
fn widen_bpm_to_real(conn: &Connection) -> DbResult<()> {
    if !table_exists(conn, "tracks")? {
        return Ok(()); // nothing to migrate; SCHEMA_SQL will create it
    }
    // Ask the question this step is about — the declared type of `bpm` — rather
    // than whether a sibling column happens to exist. The first version of this
    // guard checked for `bpm_confidence`, which conflates "already migrated"
    // with "some later column is present": a database whose recorded version was
    // rolled back for compatibility would then keep an INTEGER `bpm` forever.
    if column_type(conn, "tracks", "bpm")?.as_deref() == Some("REAL") {
        return Ok(()); // already migrated
    }

    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let result = (|| -> DbResult<()> {
        conn.execute_batch(
            r#"
BEGIN;
CREATE TABLE tracks_v5 (
    path            TEXT PRIMARY KEY,
    library_dir     TEXT NOT NULL,
    file_name       TEXT NOT NULL,
    mtime_ms        INTEGER,
    size_bytes      INTEGER,
    download_date   INTEGER,
    container       TEXT NOT NULL,
    codec           TEXT NOT NULL,
    sample_rate     INTEGER NOT NULL,
    bits_per_sample INTEGER NOT NULL,
    channels        INTEGER NOT NULL,
    duration_secs   REAL NOT NULL,
    lossless        INTEGER NOT NULL,
    title           TEXT,
    artist          TEXT,
    album           TEXT,
    album_artist    TEXT,
    genre           TEXT,
    year            TEXT,
    track_number    INTEGER,
    catalog_number  TEXT,
    label           TEXT,
    country         TEXT,
    bpm             REAL,
    bpm_confidence  REAL,
    has_cover       INTEGER NOT NULL
);
INSERT INTO tracks_v5 (
    path, library_dir, file_name, mtime_ms, size_bytes, download_date,
    container, codec, sample_rate, bits_per_sample, channels, duration_secs,
    lossless, title, artist, album, album_artist, genre, year, track_number,
    catalog_number, label, country, bpm, has_cover
)
SELECT
    path, library_dir, file_name, mtime_ms, size_bytes, download_date,
    container, codec, sample_rate, bits_per_sample, channels, duration_secs,
    lossless, title, artist, album, album_artist, genre, year, track_number,
    catalog_number, label, country, bpm, has_cover
FROM tracks;
DROP TABLE tracks;
ALTER TABLE tracks_v5 RENAME TO tracks;
COMMIT;
"#,
        )
    })();
    // Restore enforcement whatever happened, or the rest of the session runs
    // with the cascade silently disabled.
    conn.pragma_update(None, "foreign_keys", "ON")?;
    result
}

/// Adds a column unless it is already there, so a re-run is a no-op rather than
/// an error.
///
/// A table that does not exist yet is also a no-op, not a failure: migrations
/// run *before* [`SCHEMA_SQL`], so a database old enough to predate the table
/// gets it created with the column already in place.
fn add_column(conn: &Connection, table: &str, column: &str, ty: &str) -> DbResult<()> {
    if !table_exists(conn, table)? || column_exists(conn, table, column)? {
        return Ok(());
    }
    conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {ty}"))?;
    Ok(())
}

/// Is this table there at all?
fn table_exists(conn: &Connection, table: &str) -> DbResult<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |_| Ok(true),
        )
        .unwrap_or(false))
}

/// Does a table have this column? Used to make a migration idempotent without
/// relying on the recorded version alone.
fn column_exists(conn: &Connection, table: &str, column: &str) -> DbResult<bool> {
    Ok(column_type(conn, table, column)?.is_some())
}

/// The declared type of a column, or `None` when there is no such column.
fn column_type(conn: &Connection, table: &str, column: &str) -> DbResult<Option<String>> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(Some(row.get::<_, String>(2)?.to_uppercase()));
        }
    }
    Ok(None)
}
