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
 * The marker line, as the changelog may write it: with or without the bold
 * asterisks, with the colon inside or outside them, in any case.
 *
 * Strict on purpose, in both directions. It is a whole line and nothing else —
 * the colon is required and no sentence may follow the level — because the two
 * readers below disagree in opposite, equally wrong ways otherwise: a bullet
 * that discusses severity would set a banner nobody meant, and a sentence
 * beginning with the word would be deleted from the notes on screen. One
 * pattern, so a line `severityOf` reads is exactly a line `withoutSeverity`
 * removes.
 */
const MARKER = /^[^\S\n]*\*{0,2}Severity(?::\*{0,2}|\*{0,2}:)[^\S\n]*(\w+)[^\S\n]*$/im;

/**
 * The level the notes mark, or null. Anything else — a word we do not know, a
 * missing line, no notes at all — is an ordinary update, because a banner nobody
 * meant to trigger is worse than a quiet one, and a typo should not invent one.
 */
export function severityOf(notes: string | undefined | null): Severity | null {
  if (!notes) return null;
  const m = MARKER.exec(notes);
  if (!m) return null;
  const word = m[1].toLowerCase();
  return LEVELS.find((l) => l === word) ?? null;
}

/**
 * The notes without their marker line.
 *
 * The severity is already on screen as a tag or a banner by the time the notes
 * are rendered, so leaving the raw `**Severity:** critical` in the text says it
 * twice — the second time in the one form nobody was meant to read. Removed
 * whatever the word is: an unknown level ships as an ordinary release, but the
 * line was still written as a marker rather than as a sentence.
 */
export function withoutSeverity(notes: string): string {
  return notes.replace(MARKER, "").trim();
}

/**
 * The notes as they should be shown, or null when there is nothing to show.
 *
 * Null is not the same as "no notes": a release whose section is only the
 * severity marker has notes, and nothing left once the marker is taken out. The
 * callers need that distinction to choose between the "came without notes" line
 * and an empty framed box.
 */
export function renderableNotes(
  notes: string | undefined | null,
): string | null {
  if (!notes) return null;
  const text = withoutSeverity(notes);
  return text.length ? text : null;
}
