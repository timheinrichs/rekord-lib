/**
 * The scan, against real files.
 *
 * This is the half the jsdom flows cannot reach. There a fake answers
 * `start_scan` and the assertion is about wiring; here the real detector decodes
 * real audio and the real tag writer puts the result into the file. The fixture
 * is built for exactly that: `scripts/dev-library.py` generates a click track at
 * a known tempo, so the expected value is known by construction rather than
 * measured.
 *
 * Assertions are made against the filesystem rather than the DOM wherever
 * possible. Not out of preference — the file is the actual product — but also
 * because every WebDriver call pays a five-second probe here (see the CSP note
 * in docs/TESTING.md), so a spec that polls the DOM is a spec nobody runs.
 *
 * One consequence to be clear about: the fixture is regenerated once per run,
 * by `npm run e2e`, and not once per spec. Every spec launches an app that scans
 * the whole library, so by the time this one runs the tags may already have been
 * written by an earlier spec's instance — which is why it can pass in
 * milliseconds. That is deliberate: regenerating and rescanning per spec would
 * multiply the runtime for no new information. The claim being made is therefore
 * about the run, not about which instance did the writing: after this suite has
 * driven the app over a freshly generated library, the tempo is in the file.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = JSON.parse(
  readFileSync(join(ROOT, ".dev", "e2e-app.json"), "utf8"),
) as { libraryPath: string };

const CLICK_090 = join(app.libraryPath, "Clicks", "click-090.aiff");
const FFPROBE = join(
  ROOT,
  "src-tauri",
  "binaries",
  "ffprobe-aarch64-apple-darwin",
);

/** The tempo tag actually in the file, read with the bundled ffprobe. */
function tempoTagOf(path: string): string {
  const out = execFileSync(
    FFPROBE,
    ["-v", "error", "-show_entries", "format_tags", "-of", "default=nw=1", path],
    { encoding: "utf8" },
  );
  const line = out
    .split("\n")
    .find((l) => /^TAG:(TBPM|BPM|bpm)=/i.test(l.trim()));
  return line ? line.split("=")[1].trim() : "";
}

/**
 * Poll the filesystem, not the app. Node's own timers cost nothing, so this can
 * check often without paying for a WebDriver round trip.
 */
async function until(
  check: () => boolean,
  { timeout, what }: { timeout: number; what: string },
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${what}`);
}

describe("scanning the fixture library", () => {
  it("writes the detected tempo into the file, not only into the database", async () => {
    // The scan is not a read-only observer, and this is the only place that can
    // prove it. `CLAUDE.md` warns about the same thing for a dev run, and for
    // the same reason: this really does rewrite tags on disk.
    //
    // The window is not touched at all here — the app is already running its
    // first scan, and asking it anything would only cost time.
    await until(() => tempoTagOf(CLICK_090) !== "", {
      timeout: 480_000,
      what: "the tempo tag to reach the file",
    });

    // 90 by construction: the fixture is a click at exactly that tempo. Rounded
    // on the way into the tag, which is all a tag can hold.
    expect(Math.round(Number(tempoTagOf(CLICK_090)))).toBe(90);
  });
});
