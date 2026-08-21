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
/// Absolute, and at least two components deep. A relative path would resolve
/// against whatever the process's working directory happens to be; `/` would
/// hand back everything; and every one-component path on macOS is a system
/// folder — `/Users`, `/Volumes`, `/etc` — never somebody's music. `..` is
/// resolved here rather than left to the scope's globbing, where
/// `/Users/me/Music/../..` quietly becomes `/Users`.
pub fn playable_dir(settings: Option<&Value>) -> Option<String> {
    let dir = settings?.get("library_dir")?.as_str()?.trim();
    if dir.is_empty() {
        return None;
    }
    normalize(dir)
}

/// Lexical normalisation: absolute, `.` and `..` resolved, and deep enough to
/// be a folder someone keeps music in. Lexical rather than `canonicalize`,
/// because the answer must not depend on whether the folder is mounted right
/// now — an unplugged drive is a folder the user still has.
fn normalize(dir: &str) -> Option<String> {
    use std::path::{Component, PathBuf};
    let path = std::path::Path::new(dir);
    if !path.is_absolute() {
        return None;
    }
    let mut out = PathBuf::from("/");
    let mut depth = 0usize;
    for part in path.components() {
        match part {
            Component::RootDir | Component::Prefix(_) | Component::CurDir => {}
            Component::ParentDir => {
                if depth == 0 {
                    return None;
                }
                out.pop();
                depth -= 1;
            }
            Component::Normal(p) => {
                out.push(p);
                depth += 1;
            }
        }
    }
    if depth < 2 {
        return None;
    }
    Some(out.to_string_lossy().to_string())
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

    fn dir(value: &str) -> Option<String> {
        playable_dir(Some(&json!({ "library_dir": value })))
    }

    #[test]
    fn playable_dir_refuses_what_must_not_become_a_scope() {
        // No settings, and no folder chosen yet.
        assert_eq!(playable_dir(None), None);
        assert_eq!(playable_dir(Some(&json!({}))), None);
        assert_eq!(playable_dir(Some(&json!({ "library_dir": null }))), None);
        assert_eq!(dir(""), None);
        assert_eq!(dir("  "), None);
        // Relative: it would resolve against the working directory.
        assert_eq!(dir("Music"), None);
        assert_eq!(dir("./Music"), None);
        // The root and the system folders one level under it — including the
        // two the static scope used to name.
        assert_eq!(dir("/"), None);
        assert_eq!(dir("/Users"), None);
        assert_eq!(dir("/Volumes"), None);
        assert_eq!(dir("/etc"), None);
    }

    #[test]
    fn playable_dir_resolves_a_path_that_walks_back_up() {
        // Left to the scope's globbing this is `/Users`, which is the scope
        // this module exists to refuse.
        assert_eq!(dir("/Users/me/Music/../.."), None);
        assert_eq!(dir("/Users/me/Music/../Beats").as_deref(), Some("/Users/me/Beats"));
        assert_eq!(dir("/Users/me/./Music").as_deref(), Some("/Users/me/Music"));
        assert_eq!(dir("/../etc/passwd"), None);
        // An external drive is two deep and perfectly ordinary.
        assert_eq!(dir("/Volumes/DJ/Music").as_deref(), Some("/Volumes/DJ/Music"));
    }
}
