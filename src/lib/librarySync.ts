import type { ConvertResult, TrackAnalysis } from "../types";

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

/** Output paths of successful conversions (to re-analyze after a convert). */
export function convertedOutputs(results: ConvertResult[]): string[] {
  const out = new Set<string>();
  for (const r of results) {
    if (r.success && r.output_path) out.add(r.output_path);
  }
  return [...out];
}

/**
 * Merges freshly analyzed conversion outputs back into the library. Both the
 * original source and the output path of each successful conversion are dropped
 * from the existing tracks — an in-place convert keeps the same path (its stale
 * analysis is replaced), a format change replaces the old path — then the
 * re-analyzed outputs are appended. Pure; reference-stable when nothing changed.
 */
export function mergeConverted(
  tracks: TrackAnalysis[],
  results: ConvertResult[],
  analyzed: TrackAnalysis[],
): TrackAnalysis[] {
  const drop = new Set<string>();
  for (const r of results) {
    if (!r.success || !r.output_path) continue;
    drop.add(r.source_path);
    drop.add(r.output_path);
  }
  if (drop.size === 0) return tracks;
  const kept = tracks.filter((t) => !drop.has(t.path));
  return [...kept, ...analyzed];
}
