import type { SkippedFile } from "../types";

/**
 * Adds a reported skip to the list the UI shows.
 *
 * Keyed by path, newest reason wins: the same file is met again by every sweep,
 * and a run that skipped it for a different reason than the last one is telling
 * us something newer, not something additional. Without that the list would
 * grow by the whole set of broken files on every scan.
 */
export function addSkipped(
  prev: SkippedFile[],
  file: SkippedFile,
): SkippedFile[] {
  const at = prev.findIndex((f) => f.path === file.path);
  if (at === -1) return [...prev, file];
  if (prev[at].reason === file.reason) return prev;
  const next = [...prev];
  next[at] = file;
  return next;
}

/**
 * The label of the button that opens the list, or `null` when there is nothing
 * to show. Counting files rather than naming them: the point of the button is
 * that a scan quietly leaving things out is now visible at all.
 */
export function skippedLabel(files: SkippedFile[]): string | null {
  if (!files.length) return null;
  return files.length === 1 ? "1 file skipped" : `${files.length} files skipped`;
}

/**
 * The list as text, for the copy button — the form a bug report can be pasted
 * into. One file per line, reason last, so a long list stays scannable.
 */
export function skippedAsText(files: SkippedFile[]): string {
  return files.map((f) => `${f.path} — ${f.reason}`).join("\n");
}
