/**
 * Reads the severity a release marked itself with.
 *
 * The marker is a line in `CHANGELOG.md` under the version heading, which the
 * release workflow copies into the release body and from there into the
 * updater's notes (`scripts/release-notes.mjs`). Parsing it here rather than
 * carrying a field in `latest.json` keeps one source of truth: what the
 * changelog says is what the app shows.
 */
export type Severity = "critical";

/**
 * `critical` when the notes mark the release as such, otherwise null. Anything
 * else — a word we do not know, a missing line, no notes at all — is an ordinary
 * update, because a banner nobody meant to trigger is worse than a quiet one.
 */
export function severityOf(notes: string | undefined | null): Severity | null {
  if (!notes) return null;
  const m = /^\s*\*{0,2}Severity:?\*{0,2}\s*:?\s*(\w+)/im.exec(notes);
  return m && m[1].toLowerCase() === "critical" ? "critical" : null;
}
