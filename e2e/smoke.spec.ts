/**
 * The spike, kept as the suite's first spec: does the embedded WebDriver server
 * actually drive a WKWebView, and does the app come up far enough to be driven?
 *
 * Everything else in this folder assumes both. If this one fails, no other
 * failure in here means anything.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const app = JSON.parse(
  readFileSync(join(ROOT, ".dev", "e2e-app.json"), "utf8"),
) as { libraryPath: string; dataDir: string };

describe("the app comes up", () => {
  it("renders into the window", async () => {
    // The splash holds for at least MIN_SPLASH_MS and the boot loads the
    // library, so this waits rather than reads.
    await $("#root > *").waitForExist({
      timeoutMsg: "the window never rendered anything under #root",
    });
    expect(await browser.getTitle()).toContain("rekord-lib");
  });

  it("runs against the e2e fixture library, not a real one", async () => {
    // The one assertion worth making before any spec touches a file: this app
    // instance is pointed at the generated fixture and its own data directory.
    // `scripts/e2e-app.mjs` sets both up; if that ever silently stops working,
    // the next spec would convert and trash files somewhere else.
    expect(app.libraryPath).toContain(join(".dev", "e2e-library"));
    expect(app.dataDir).toContain("rekord-lib-e2e");

    const settings = JSON.parse(
      readFileSync(join(app.dataDir, "rekord-lib.json"), "utf8"),
    );
    expect(settings.settings.library_dir).toBe(app.libraryPath);
  });
});
