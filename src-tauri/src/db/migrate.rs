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
    if is_done(&conn)? {
        return Ok(Imported::default());
    }

    // No store at all means nothing was ever saved — there is nothing to
    // import, now or later.
    let (library, duplicates) = match app.store(STORE_FILE) {
        Ok(store) => (store.get(LIBRARY_KEY), store.get(DUPLICATES_KEY)),
        Err(_) => (None, None),
    };
    let imported = import(&mut conn, library, duplicates)?;
    meta_set(&conn, schema::KEY_MIGRATED_FROM_JSON, "1")?;
    Ok(imported)
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
        assert_eq!(tracks[0].metadata.bpm, Some(123));
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
    fn the_done_flag_gates_the_import() {
        let db = Db::open_in_memory().unwrap();
        let conn = db.0.lock().unwrap();
        assert!(!is_done(&conn).unwrap());
        meta_set(&conn, schema::KEY_MIGRATED_FROM_JSON, "1").unwrap();
        assert!(is_done(&conn).unwrap());
    }
}
