//! One-time import of the library from the legacy JSON store.
//!
//! Before the database existed, the whole track list lived under the `library`
//! key of `rekord-lib.json` and was written from the frontend. This module moves
//! that content into SQLite on first start and records that it happened, so it
//! runs exactly once.
//!
//! The JSON key is left in place on purpose: it costs nothing to keep for a
//! release, and it means a downgrade still finds its data.

use std::collections::HashMap;

use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use super::{fs_identity, meta_get, meta_set, schema, Db, DbResult, TrackRecord};
use crate::error::AppResult;
use crate::models::TrackAnalysis;

/// Store file and keys that held the library before the database.
const STORE_FILE: &str = "rekord-lib.json";
const LIBRARY_KEY: &str = "library";
const DUPLICATES_KEY: &str = "duplicates";

/// Shape of the legacy `library` value.
#[derive(Deserialize)]
struct LegacyLibrary {
    #[serde(default)]
    library_dir: Option<String>,
    #[serde(default)]
    tracks: Vec<TrackAnalysis>,
    #[serde(default)]
    edits: HashMap<String, Value>,
}

/// What an import moved, for logging.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Imported {
    pub tracks: usize,
    pub edits: usize,
    pub duplicate_groups: usize,
}

/// Has the JSON import already run?
pub fn is_done(conn: &rusqlite::Connection) -> DbResult<bool> {
    Ok(meta_get(conn, schema::KEY_MIGRATED_FROM_JSON)?.as_deref() == Some("1"))
}

/// Imports the legacy library if that has not happened yet.
///
/// Never fatal: a failure here leaves the flag unset, so the next start tries
/// again, and the app meanwhile behaves like a fresh install (the first scan
/// rebuilds the database anyway).
pub fn run(app: &AppHandle, db: &Db) -> AppResult<Imported> {
    let mut conn = db.conn()?;

    // No store at all means nothing was ever saved — there is nothing to
    // import, now or later.
    let Ok(store) = app.store(STORE_FILE) else {
        meta_set(&conn, schema::KEY_MIGRATED_FROM_JSON, "1")?;
        return Ok(Imported::default());
    };

    let imported = if is_done(&conn)? {
        Imported::default()
    } else {
        let result = import(&mut conn, store.get(LIBRARY_KEY), store.get(DUPLICATES_KEY))?;
        meta_set(&conn, schema::KEY_MIGRATED_FROM_JSON, "1")?;
        result
    };

    // Deliberately outside the import gate: the keys have to go on whichever
    // start it first becomes safe, not only on the one that imported. Deleting
    // an absent key is a no-op, so this costs nothing once done.
    shed_legacy_keys(&conn, &store)?;
    Ok(imported)
}

/// Removes the legacy `library` and `duplicates` keys once the database
/// demonstrably holds the library.
///
/// They are what made the store file multi-megabyte, and every settings change
/// rewrites the whole file — so keeping them costs on every save. The guard is
/// the point though: only drop them when the database has at least as many
/// tracks for that folder as the JSON claims. Anything less means the import
/// fell short, and the JSON is then the only remaining copy.
fn shed_legacy_keys(
    conn: &rusqlite::Connection,
    store: &std::sync::Arc<tauri_plugin_store::Store<tauri::Wry>>,
) -> DbResult<()> {
    let Some(library) = store.get(LIBRARY_KEY) else {
        return Ok(()); // already gone
    };
    let expected = json_track_count(Some(&library));
    let dir = library
        .get("library_dir")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if expected > 0 && !database_holds(conn, dir, expected)? {
        return Ok(());
    }
    store.delete(LIBRARY_KEY);
    store.delete(DUPLICATES_KEY);
    if let Err(e) = store.save() {
        eprintln!("Could not shrink the legacy store: {e}");
    } else {
        println!("Legacy library keys removed from the JSON store");
    }
    Ok(())
}

/// Does the database hold at least `expected` tracks for `dir`?
fn database_holds(conn: &rusqlite::Connection, dir: &str, expected: usize) -> DbResult<bool> {
    if dir.is_empty() {
        return Ok(false);
    }
    let stored: i64 = conn.query_row(
        "SELECT count(*) FROM tracks WHERE library_dir = ?1",
        rusqlite::params![dir],
        |row| row.get(0),
    )?;
    Ok(stored as usize >= expected)
}

/// Number of tracks the legacy value claims to hold, for the check below.
fn json_track_count(library: Option<&Value>) -> usize {
    library
        .and_then(|v| v.get("tracks"))
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0)
}

/// The import itself, separated from the store so it can be tested against
/// plain JSON values.
///
/// Tolerant by design: anything unparsable is skipped rather than aborting the
/// import, because the alternative — refusing to start with a library the user
/// can see no problem with — is worse than losing a stale cache entry.
pub fn import(
    conn: &mut rusqlite::Connection,
    library: Option<Value>,
    duplicates: Option<Value>,
) -> DbResult<Imported> {
    let mut imported = Imported::default();

    if let Some(legacy) = library.and_then(|v| serde_json::from_value::<LegacyLibrary>(v).ok()) {
        // Without a library folder the rows could not be scoped to one, and
        // every read is per-folder — such a cache is unusable, so skip it.
        if let Some(dir) = legacy.library_dir.filter(|d| !d.is_empty()) {
            // Stat every file while importing: it fills in the identity the
            // JSON never stored, so the first sweep after the update can
            // already skip unchanged files instead of re-probing everything.
            let records: Vec<TrackRecord> = legacy
                .tracks
                .into_iter()
                .map(|track| TrackRecord {
                    fs: fs_identity(&track.path),
                    track,
                })
                .collect();
            super::upsert_tracks(conn, &dir, &records)?;
            imported.tracks = records.len();
        }
        for (path, payload) in &legacy.edits {
            super::set_edit(conn, path, payload)?;
        }
        imported.edits = legacy.edits.len();
    }

    if let Some(Value::Array(groups)) = duplicates {
        super::save_duplicate_groups(conn, &groups)?;
        imported.duplicate_groups = groups.len();
    }

    Ok(imported)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn legacy_track(path: &str) -> Value {
        serde_json::json!({
            "id": path,
            "path": path,
            "file_name": "a.aiff",
            "audio": {
                "container": "aiff",
                "codec": "pcm_s16be",
                "sample_rate": 44100,
                "bits_per_sample": 16,
                "channels": 2,
                "duration_secs": 100.0,
                "lossless": true
            },
            "metadata": {
                "title": "T", "artist": "A", "album": "Al", "album_artist": "AA",
                "genre": null, "year": null, "track_number": null, "bpm": 123,
                "has_cover": false
            },
            "compat": { "compatible": true, "issues": [] },
            "metadata_incomplete": false,
            "download_date": 1700000000000i64
        })
    }

    #[test]
    fn imports_tracks_edits_and_duplicate_groups() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let library = serde_json::json!({
            "library_dir": "/lib",
            "tracks": [legacy_track("/lib/a.aiff"), legacy_track("/lib/b.aiff")],
            "edits": { "/lib/a.aiff": { "metadata": { "title": "New" } } }
        });
        let duplicates = serde_json::json!([{ "id": "/lib/a.aiff", "files": [] }]);

        let imported = import(&mut conn, Some(library), Some(duplicates)).unwrap();
        assert_eq!(
            imported,
            Imported {
                tracks: 2,
                edits: 1,
                duplicate_groups: 1
            }
        );

        let tracks = super::super::load_tracks(&conn, "/lib").unwrap();
        assert_eq!(tracks.len(), 2);
        assert_eq!(tracks[0].metadata.bpm, Some(123.0));
        assert_eq!(super::super::load_edits(&conn).unwrap().len(), 1);
        assert_eq!(super::super::load_duplicate_groups(&conn).unwrap().len(), 1);
    }

    #[test]
    fn imported_tracks_have_no_identity_when_the_file_is_gone() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let library = serde_json::json!({
            "library_dir": "/lib",
            "tracks": [legacy_track("/lib/definitely-not-on-disk.aiff")],
            "edits": {}
        });
        import(&mut conn, Some(library), None).unwrap();

        // The track shows up in the library …
        assert_eq!(super::super::load_tracks(&conn, "/lib").unwrap().len(), 1);
        // … but has nothing to validate against, so the next scan re-probes it.
        assert!(super::super::load_track_cache(&conn, "/lib")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn imported_tracks_get_the_identity_of_a_file_that_exists() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.aiff");
        std::fs::write(&file, b"some bytes").unwrap();
        let path = file.to_string_lossy().to_string();

        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let library = serde_json::json!({
            "library_dir": dir.path().to_string_lossy(),
            "tracks": [legacy_track(&path)],
            "edits": {}
        });
        import(&mut conn, Some(library), None).unwrap();

        let cache = super::super::load_track_cache(&conn, &dir.path().to_string_lossy()).unwrap();
        assert_eq!(cache.len(), 1);
        assert_eq!(cache[&path].fs.size_bytes, 10);
    }

    #[test]
    fn library_without_a_folder_is_skipped() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        // Rows are read per folder, so a cache with no folder is unusable.
        for dir in [Value::Null, Value::String(String::new())] {
            let library = serde_json::json!({
                "library_dir": dir,
                "tracks": [legacy_track("/lib/a.aiff")],
                "edits": {}
            });
            let imported = import(&mut conn, Some(library), None).unwrap();
            assert_eq!(imported.tracks, 0);
        }
    }

    #[test]
    fn nothing_to_import_is_not_an_error() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        assert_eq!(import(&mut conn, None, None).unwrap(), Imported::default());
        // Garbage in the store is skipped rather than failing the start.
        assert_eq!(
            import(&mut conn, Some(serde_json::json!("nonsense")), None).unwrap(),
            Imported::default()
        );
        // A duplicates value of the wrong shape is ignored too.
        assert_eq!(
            import(&mut conn, None, Some(serde_json::json!({"not": "an array"})))
                .unwrap()
                .duplicate_groups,
            0
        );
    }

    #[test]
    fn a_second_import_is_idempotent() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let library = serde_json::json!({
            "library_dir": "/lib",
            "tracks": [legacy_track("/lib/a.aiff")],
            "edits": {}
        });
        import(&mut conn, Some(library.clone()), None).unwrap();
        import(&mut conn, Some(library), None).unwrap();
        // Keyed by path — running twice cannot double the library.
        assert_eq!(super::super::load_tracks(&conn, "/lib").unwrap().len(), 1);
    }

    #[test]
    fn json_track_count_reads_the_legacy_shape() {
        assert_eq!(json_track_count(None), 0);
        assert_eq!(json_track_count(Some(&serde_json::json!({}))), 0);
        assert_eq!(json_track_count(Some(&serde_json::json!("nonsense"))), 0);
        assert_eq!(
            json_track_count(Some(&serde_json::json!({"tracks": []}))),
            0
        );
        assert_eq!(
            json_track_count(Some(&serde_json::json!({"tracks": [1, 2, 3]}))),
            3
        );
    }

    #[test]
    fn legacy_keys_only_go_once_the_rows_are_really_there() {
        let db = Db::open_in_memory().unwrap();
        let mut conn = db.0.lock().unwrap();
        let library = serde_json::json!({
            "library_dir": "/lib",
            "tracks": [legacy_track("/lib/a.aiff"), legacy_track("/lib/b.aiff")],
            "edits": {}
        });

        // Nothing imported yet: the JSON is the only copy, so it has to stay.
        assert!(!database_holds(&conn, "/lib", 2).unwrap());

        import(&mut conn, Some(library), None).unwrap();
        assert!(database_holds(&conn, "/lib", 2).unwrap());
        // More in the database than the JSON claimed is fine too.
        assert!(database_holds(&conn, "/lib", 1).unwrap());
        // A short import must not be mistaken for a complete one.
        assert!(!database_holds(&conn, "/lib", 3).unwrap());
        // Another folder's rows do not vouch for this one.
        assert!(!database_holds(&conn, "/elsewhere", 1).unwrap());
        // Without a folder there is nothing to compare against.
        assert!(!database_holds(&conn, "", 1).unwrap());
    }

    #[test]
    fn the_done_flag_gates_the_import() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        assert!(!is_done(&conn).unwrap());
        meta_set(&conn, schema::KEY_MIGRATED_FROM_JSON, "1").unwrap();
        assert!(is_done(&conn).unwrap());
    }
}
