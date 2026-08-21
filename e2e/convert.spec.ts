/**
 * A conversion that really moves a file.
 *
 * `TODO.md` names `commands::convert_tracks` as the untested path that matters
 * most, because it is the one that writes over the user's files: the output is
 * built next to the source and then renamed over it. The jsdom flow can only
 * check which options the frontend asks for. This checks the file afterwards.
 *
 * The fixture is chosen so the answer is unambiguous. `Formats/96khz-24bit.aiff`
 * is rejected by the compatibility rules for both its sample rate and its bit
 * depth, and the conversion target is 44.1 kHz / 16-bit — so one file, one path,
 * two properties that must both change.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = JSON.parse(
  readFileSync(join(ROOT, ".dev", "e2e-app.json"), "utf8"),
) as { libraryPath: string };

const SOURCE = join(app.libraryPath, "Formats", "96khz-24bit.aiff");
const FFPROBE = join(
  ROOT,
  "src-tauri",
  "binaries",
  "ffprobe-aarch64-apple-darwin",
);

/** Sample rate and bit depth as the file itself reports them. */
function audioOf(path: string): { rate: number; bits: number } {
  const out = execFileSync(
    FFPROBE,
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=sample_rate,bits_per_raw_sample,bits_per_sample",
      "-of",
      "default=nw=1",
      path,
    ],
    { encoding: "utf8" },
  );
  const value = (key: string) => {
    const line = out.split("\n").find((l) => l.startsWith(`${key}=`));
    return line ? Number(line.split("=")[1]) : 0;
  };
  return {
    rate: value("sample_rate"),
    bits: value("bits_per_raw_sample") || value("bits_per_sample"),
  };
}

/** `audioOf`, but a file that cannot be probed right now counts as "not yet". */
function probe(path: string): { rate: number; bits: number } | null {
  try {
    return audioOf(path);
  } catch {
    return null;
  }
}

async function untilFile(
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

describe("converting a file the players cannot read", () => {
  it("rewrites the file in place, at the target rate and depth", async () => {
    // What we start from, read from the file rather than assumed.
    const before = audioOf(SOURCE);
    expect(before.rate).toBe(96_000);
    expect(before.bits).toBe(24);

    // Selecting a row is the path that needs no hover: the row's own Convert
    // button only appears under the pointer, while the selection toolbar's is
    // always there.
    const checkbox = $('input[aria-label="Select 96khz-24bit.aiff"]');
    // A long interval on purpose — every poll is a WebDriver round trip, and
    // each of those pays a five-second probe (see docs/TESTING.md).
    await checkbox.waitForExist({ timeout: 420_000, interval: 5_000 });
    await checkbox.click();

    const convert = $("button*=Convert selection");
    await convert.waitForExist({ timeout: 60_000, interval: 5_000 });
    await convert.click();

    // From here on the app is left alone and the file is watched instead.
    // `audioOf` shells out to ffprobe, which throws if the file is momentarily
    // absent — and would if a future target format ever made the conversion
    // trash the source instead of renaming over it. A throwing poll would
    // replace the message below with a raw ffprobe error.
    await untilFile(() => probe(SOURCE)?.rate === 44_100, {
      timeout: 300_000,
      what: "the converted file to replace the source",
    });

    const after = audioOf(SOURCE);
    // Both properties, at the same path: the output was renamed over the source
    // rather than left beside it.
    expect(after.rate).toBe(44_100);
    expect(after.bits).toBe(16);
  });
});
