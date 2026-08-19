import type { TrackAnalysis } from "../types";
import type { WriteMetadataResult } from "./api";

/**
 * What the library shows after a batch of tag writes: every file that was
 * written comes back re-analyzed, keyed by path, and replaces its row. Rows the
 * batch did not mention — and rows whose write failed, which carry no track —
 * stay exactly as they were. Pure.
 */
export function applyWrittenTracks(
  prev: TrackAnalysis[],
  results: WriteMetadataResult[],
): TrackAnalysis[] {
  const byPath = new Map(results.map((r) => [r.path, r]));
  return prev.map((t) => byPath.get(t.path)?.track ?? t);
}

/**
 * The track ids whose tags are now on disk, so their pending edit can be
 * dropped. A failed write keeps its edit — the change must not be lost just
 * because it could not be persisted yet.
 */
export function writtenIds(results: WriteMetadataResult[]): string[] {
  return results.filter((r) => r.track).map((r) => r.track!.id);
}

/**
 * One line about the files that failed, or `null` when everything was written.
 * The individual errors are joined rather than summarised: with a handful of
 * files they are the whole diagnosis, and there is nothing else to consult.
 */
export function writeErrorMessage(
  results: WriteMetadataResult[],
): string | null {
  const failed = results.filter((r) => r.error);
  if (!failed.length) return null;
  const detail = failed
    .map((f) => f.error)
    .filter(Boolean)
    .join("; ");
  return `Failed to write tags for ${failed.length} file(s): ${detail}`;
}
