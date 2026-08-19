import { invoke } from "@tauri-apps/api/core";
import type { TrackAnalysis, TrackEdit } from "../types";

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
