import { invoke } from "@tauri-apps/api/core";
import type { DuplicateGroup } from "../types";

/**
 * Duplicate groups are a derived cache, stored alongside the tracks in SQLite.
 * A finished dedupe run persists its own result in the backend; the frontend
 * only writes back a pruned version once files are gone.
 */

/** The most recently found duplicate groups (or empty). */
export function loadDuplicates(): Promise<DuplicateGroup[]> {
  return invoke<DuplicateGroup[]>("duplicates_load");
}

/** Replaces the stored duplicate groups. */
export function saveDuplicates(groups: DuplicateGroup[]): Promise<void> {
  return invoke("duplicates_save", { groups });
}
