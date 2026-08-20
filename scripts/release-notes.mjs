#!/usr/bin/env node
/**
 * Cuts one version's section out of CHANGELOG.md, for the release body.
 *
 * The release workflow hands the result to tauri-action as `releaseBody`, which
 * is also what ends up in `latest.json`'s `notes` — so this is what the updater
 * shows people before they install. That makes the changelog the single source:
 * the release notes cannot drift from it, and a `**Severity:** critical` line
 * under the heading reaches the app without a second place to maintain.
 *
 * Usage: node scripts/release-notes.mjs 0.6.1 [path/to/CHANGELOG.md]
 * Exits non-zero when there is no section for that version — a release with
 * empty notes is worse than a failed build, because nobody notices it.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** `## [0.6.1] - 2026-08-20`, and the bare `## [Unreleased]` heading too. */
const HEADING = /^##\s+\[([^\]]+)\]/;

/**
 * The body of `version`'s section: everything between its heading and the next
 * one, with the link definitions at the bottom of the file left out.
 *
 * Deliberately tolerant of what the file actually contains — sections in any
 * order, free prose directly under a heading, a `### Note` block, bullets
 * wrapped over several lines — because none of that is this function's business.
 * Returns null when the version has no section.
 */
export function sectionFor(markdown, version) {
  const lines = markdown.split("\n");
  const wanted = version.replace(/^v/, "");
  let start = -1;
  let end = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const m = HEADING.exec(lines[i]);
    if (!m) continue;
    if (start === -1) {
      if (m[1] === wanted) start = i + 1;
    } else {
      end = i;
      break;
    }
  }
  if (start === -1) return null;

  const body = lines
    .slice(start, end)
    // A link definition is the file's own bookkeeping, not release notes.
    .filter((l) => !/^\[[^\]]+\]:\s+http/.test(l))
    .join("\n")
    .trim();
  return body.length ? body : null;
}

/** The severity marked under a version heading, if any. */
export function severityIn(section) {
  const m = /^\s*\*\*Severity:\*\*\s*(\w+)/im.exec(section ?? "");
  return m ? m[1].toLowerCase() : null;
}

async function main() {
  const [version, file] = process.argv.slice(2);
  if (!version) {
    console.error("usage: release-notes.mjs <version> [changelog]");
    process.exit(2);
  }
  const changelog =
    file ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "CHANGELOG.md",
    );
  const section = sectionFor(await readFile(changelog, "utf8"), version);
  if (!section) {
    console.error(
      `No CHANGELOG.md section for ${version}. Add one before tagging — ` +
        `the release body and the updater's notes both come from it.`,
    );
    process.exit(1);
  }
  process.stdout.write(section + "\n");
}

// Only when run as a script, so the tests can import the two functions.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await main();
}
