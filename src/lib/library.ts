import { invoke } from "@tauri-apps/api/core";
import type { RelocateResult, TrackAnalysis, TrackEdit } from "../types";

/**
 * The track database lives in SQLite in the Rust backend, not in the JSON
 * store: it grows with the collection and is written incrementally while a scan
 * runs, which a store file rewritten in full on every save cannot do. The scan
 * persists its own results, so there is deliberately no "save the whole
 * library" call here — only reads and the targeted writes below.
 */

/** The stored tracks of a library folder (empty before the first scan). */
export function loadLibraryTracks(dir: string): Promise<TrackAnalysis[]> {
  return invoke<TrackAnalysis[]>("library_load", { dir });
}

/**
 * Forgets tracks by path. A full sweep prunes what it did not see on its own;
 * this is for files the frontend noticed had vanished (the disk diff in
 * `diffAudioFiles`), so the cache does not keep serving them.
 */
export function forgetTracks(paths: string[]): Promise<number> {
  return invoke<number>("library_delete", { paths });
}

/**
 * Whether the library folder can be listed right now. A folder that was
 * renamed, moved or unmounted looks exactly like an empty library in the track
 * list, and only one of the two is worth offering a relocate for.
 */
export function isLibraryDirAvailable(dir: string): Promise<boolean> {
  return invoke<boolean>("library_dir_available", { dir });
}

/**
 * Lets the player read the audio files in the saved library folder.
 *
 * The webview may read nothing at all through `asset:` until this says
 * otherwise — the scope in `tauri.conf.json` is empty, and used to be the whole
 * home folder. It takes no folder on purpose: the backend reads the one the
 * user saved, so a call from here cannot ask for anything else. Which is why it
 * has to run **after** the settings are written, not before.
 */
export function allowLibraryPlayback(): Promise<void> {
  return invoke("allow_library_playback");
}

/**
 * Re-points the library at `newDir`, keeping the identity of every track that
 * is actually there — and with it its pending edits and cached fingerprint.
 * Rows it cannot find stay where they are; this runs when the user is
 * recovering a moved folder, so it never deletes.
 */
export function relocateLibrary(
  oldDir: string,
  newDir: string,
): Promise<RelocateResult> {
  return invoke<RelocateResult>("library_relocate", { oldDir, newDir });
}

/** All pending metadata edits, keyed by track path. */
export function loadEdits(): Promise<Record<string, TrackEdit>> {
  return invoke<Record<string, TrackEdit>>("edits_load");
}

/** Stores one pending edit — one row, not the whole library. */
export function saveEdit(path: string, edit: TrackEdit): Promise<void> {
  return invoke("edit_set", { path, edit });
}

/** Drops pending edits, once they are written to the files or undone. */
export function clearEdits(paths: string[]): Promise<void> {
  if (!paths.length) return Promise.resolve();
  return invoke("edit_clear", { paths });
}
