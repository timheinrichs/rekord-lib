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
/// - 4: `events`
/// - 3: `undo_entries`
/// - 2: `dismissed_groups`
/// - 1: initial
pub const SCHEMA_VERSION: i64 = 4;

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
    bpm             INTEGER,
    has_cover       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tracks_library_dir ON tracks(library_dir);

CREATE TABLE IF NOT EXISTS fingerprints (
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
pub fn init(conn: &Connection) -> DbResult<()> {
    apply_pragmas(conn)?;
    conn.execute_batch(SCHEMA_SQL)?;
    super::meta_set(conn, KEY_SCHEMA_VERSION, &SCHEMA_VERSION.to_string())?;
    Ok(())
}
