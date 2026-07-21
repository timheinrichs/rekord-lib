import type { TrackAnalysis } from "../types";

export interface LibraryDiff {
  /** Files on disk that aren't in the library yet (need analyzing). */
  addedPaths: string[];
  /** Existing tracks whose files still exist. */
  keptTracks: TrackAnalysis[];
  /** True if anything was added or removed. */
  changed: boolean;
}

/**
 * Diffs the audio files currently on disk against the known tracks:
 * which paths are new (to analyze) and which tracks still exist (to keep).
 * Pure — the incremental library sync builds on this.
 */
export function diffAudioFiles(
  diskPaths: string[],
  tracks: TrackAnalysis[],
): LibraryDiff {
  const disk = new Set(diskPaths);
  const have = new Set(tracks.map((t) => t.path));
  const keptTracks = tracks.filter((t) => disk.has(t.path));
  const addedPaths = diskPaths.filter((p) => !have.has(p));
  const changed =
    addedPaths.length > 0 || keptTracks.length !== tracks.length;
  return { addedPaths, keptTracks, changed };
}
