/**
 * Reads the severity a release marked itself with.
 *
 * The marker is a line in `CHANGELOG.md` under the version heading, which the
 * release workflow copies into the release body and from there into the
 * updater's notes (`scripts/release-notes.mjs`). Parsing it here rather than
 * carrying a field in `latest.json` keeps one source of truth: what the
 * changelog says is what the app shows.
 */
/**
 * Two levels, and they are not a scale to be interpolated:
 *
 * - `critical` — a security or data-loss fix. Install now.
 * - `important` — worth having soon, but nothing is at risk in the meantime.
 *
 * Anything unmarked is an ordinary release, which is most of them.
 */
export type Severity = "critical" | "important";

const LEVELS: Severity[] = ["critical", "important"];

/**
 * The level the notes mark, or null. Anything else — a word we do not know, a
 * missing line, no notes at all — is an ordinary update, because a banner nobody
 * meant to trigger is worse than a quiet one, and a typo should not invent one.
 */
export function severityOf(notes: string | undefined | null): Severity | null {
  if (!notes) return null;
  const m = /^\s*\*{0,2}Severity:?\*{0,2}\s*:?\s*(\w+)/im.exec(notes);
  if (!m) return null;
  const word = m[1].toLowerCase();
  return LEVELS.find((l) => l === word) ?? null;
}
