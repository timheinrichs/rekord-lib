import type { RelocateResult } from "../types";

/**
 * Picking a library folder is two different intentions wearing the same button.
 * Choosing a folder for the first time starts a library; choosing a different
 * one when there already is a library usually means "this is where it went" —
 * it was renamed, moved to another disk, or the volume came back under a new
 * mount point. Re-pointing the existing rows keeps every track's identity, and
 * with it the pending edits and cached fingerprints that hang off its path.
 *
 * Re-picking the same folder is neither: it changes nothing and must not run.
 */
export function shouldRelocate(
  oldDir: string | null | undefined,
  newDir: string,
): boolean {
  return !!oldDir && oldDir !== newDir;
}

/**
 * What to tell the user after a relocate, or `null` when there is nothing worth
 * saying — a fresh library has no rows to re-link, and silence is better than
 * "0 tracks re-linked".
 *
 * Skipped rows are named rather than hidden: they are the tracks that are *not*
 * where the user just pointed, and they stay in the database until a full scan
 * has actually seen the folder.
 */
export function relocateMessage(result: RelocateResult): string | null {
  if (!result.moved && !result.skipped) return null;
  const tracks = result.moved === 1 ? "track" : "tracks";
  const moved = `${result.moved} ${tracks} re-linked`;
  if (!result.skipped) return `${moved}.`;
  return `${moved}, ${result.skipped} not found in the new folder — those stay until the next full scan.`;
}
