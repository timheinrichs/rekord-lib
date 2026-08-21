/**
 * The `asset:` scope, in a built app.
 *
 * This is the one claim in the 0.7.3 security work that no other test level can
 * make. The static scope in `tauri.conf.json` is empty and the library folder is
 * granted at runtime, so "the player can still play, and nothing else can be
 * read" is a property of the real protocol handler in a real window — a jsdom
 * flow test has no protocol handler at all, and `tauri dev` is not what ships.
 *
 * Both probes load the *same bytes* through the same code path the player uses
 * (`convertFileSrc` into an `Audio` element). The only difference between them
 * is where the file sits, which is exactly the thing being tested.
 */
import { copyFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = JSON.parse(
  readFileSync(join(ROOT, ".dev", "e2e-app.json"), "utf8"),
) as { libraryPath: string };

const INSIDE = join(app.libraryPath, "Clicks", "click-090.aiff");
const OUTSIDE = join(tmpdir(), "rekord-lib-e2e-outside-the-library.aiff");

/**
 * Starts a load and leaves the verdict on `window`. Split into start and poll
 * because every WebDriver call here pays a five-second probe (see the CSP note
 * in docs/TESTING.md), so this waits in the page rather than in the runner.
 */
async function assetLoads(path: string): Promise<boolean> {
  await browser.execute((p: string) => {
    const w = window as unknown as {
      __assetProbe?: string;
      __TAURI_INTERNALS__: { convertFileSrc: (p: string) => string };
    };
    w.__assetProbe = "pending";
    const audio = new Audio();
    audio.addEventListener("loadedmetadata", () => (w.__assetProbe = "ok"));
    audio.addEventListener("error", () => (w.__assetProbe = "blocked"));
    audio.src = w.__TAURI_INTERNALS__.convertFileSrc(p);
    audio.load();
  }, path);

  let verdict = "pending";
  await browser.waitUntil(
    async () => {
      verdict = await browser.execute(
        () => (window as unknown as { __assetProbe: string }).__assetProbe,
      );
      return verdict !== "pending";
    },
    {
      timeout: 30_000,
      interval: 1_000,
      timeoutMsg: `the asset load for ${path} never resolved either way`,
    },
  );
  return verdict === "ok";
}

describe("what the window may read off disk", () => {
  before(() => {
    // The same audio, one copy outside the library. Same bytes, same element,
    // same protocol: only the folder differs.
    copyFileSync(INSIDE, OUTSIDE);
  });

  it("plays a track from the library folder", async () => {
    // The runtime grant: without it the empty static scope would take playback
    // with it, and the app would look broken rather than safe.
    expect(await assetLoads(INSIDE)).toBe(true);
  });

  it("will not read an audio file outside it", async () => {
    // What the old `$HOME/**` scope allowed, and the reason for the change.
    expect(await assetLoads(OUTSIDE)).toBe(false);
  });
});
