//! What the `asset:` protocol is allowed to read.
//!
//! The protocol exists for one feature: the player loads a track from disk
//! through `convertFileSrc`. Covers do not need it — they come back from
//! `cover_thumbnail`/`cover_preview` as data URLs — so the only folder the
//! webview ever has to read is the library.
//!
//! It used to be allowed `$HOME/**` and `/Volumes/**`, which is every document,
//! key and disk image the user owns, granted statically in `tauri.conf.json` to
//! a webview that also renders text from Bandcamp. The static scope is now
//! empty and the library folder is granted at runtime instead — at startup from
//! the saved settings, and again whenever the folder changes.

use serde_json::Value;
use tauri::{AppHandle, Manager};
use tauri_plugin_store::StoreExt;

/// Same file and key the frontend saves its settings under.
const STORE_FILE: &str = "rekord-lib.json";
const SETTINGS_KEY: &str = "settings";

/// The folder from a saved settings value that may be granted, if any.
///
/// Only an absolute path, and never the root: a relative path would be resolved
/// against whatever the process's working directory happens to be, and `/`
/// would hand back the scope this module exists to take away.
pub fn playable_dir(settings: Option<&Value>) -> Option<String> {
    let dir = settings?.get("library_dir")?.as_str()?.trim();
    let path = std::path::Path::new(dir);
    if dir.is_empty() || !path.is_absolute() || path.parent().is_none() {
        return None;
    }
    Some(dir.to_string())
}

/// Grants the webview read access to `dir` for the rest of this run.
///
/// Not persisted anywhere — the scope is rebuilt on every start, so a folder
/// that stops being the library folder stops being readable with it.
pub fn allow(app: &AppHandle, dir: &str) {
    if let Err(e) = app.asset_protocol_scope().allow_directory(dir, true) {
        eprintln!("Could not open the library folder for playback: {e}");
    }
}

/// Grants the library folder from the saved settings, if there is one.
pub fn allow_saved_library(app: &AppHandle) {
    let Ok(store) = app.store(STORE_FILE) else {
        return;
    };
    if let Some(dir) = playable_dir(store.get(SETTINGS_KEY).as_ref()) {
        allow(app, &dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn playable_dir_reads_an_absolute_library_folder() {
        let settings = json!({ "library_dir": "/Users/me/Music", "format": "aiff" });
        assert_eq!(
            playable_dir(Some(&settings)).as_deref(),
            Some("/Users/me/Music")
        );
    }

    #[test]
    fn playable_dir_refuses_what_must_not_become_a_scope() {
        // No settings, no folder yet, and the two paths that would give more
        // away than the feature needs.
        assert_eq!(playable_dir(None), None);
        assert_eq!(playable_dir(Some(&json!({}))), None);
        assert_eq!(playable_dir(Some(&json!({ "library_dir": null }))), None);
        assert_eq!(playable_dir(Some(&json!({ "library_dir": "" }))), None);
        assert_eq!(playable_dir(Some(&json!({ "library_dir": "  " }))), None);
        assert_eq!(playable_dir(Some(&json!({ "library_dir": "Music" }))), None);
        assert_eq!(playable_dir(Some(&json!({ "library_dir": "/" }))), None);
    }
}
