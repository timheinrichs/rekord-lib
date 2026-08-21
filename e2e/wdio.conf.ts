/**
 * The real end-to-end suite: WebdriverIO driving the built app.
 *
 * `tauri-driver`, which the roadmap item named, cannot do this on macOS — there
 * is no WKWebView driver tool, and macOS is the only target we ship. What can is
 * `@wdio/tauri-service` with `driverProvider: "embedded"`, where the WebDriver
 * server lives inside the app itself (`tauri-plugin-wdio-webdriver`, compiled in
 * only under the `wdio` Cargo feature).
 *
 * The specs drive the app the way a user does — click, type, read the DOM — and
 * check the results on disk from Node. They do not reach into the backend
 * through `browser.tauri.*`; see the note on the service options below.
 *
 * Run it with `npm run e2e`, which builds first. `wdio run` on its own expects
 * `.dev/e2e-app.json` from a previous build.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = join(ROOT, ".dev", "e2e-app.json");

let app: { binaryPath: string; libraryPath: string; dataDir: string };
try {
  app = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch {
  throw new Error(
    `no e2e app found (${MANIFEST}). Run \`npm run e2e:build\` first, or \`npm run e2e\`, which builds.`,
  );
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./*.spec.ts"],
  // One at a time. The specs convert files and write tags in one shared fixture
  // library, so two instances would race over the same folder.
  maxInstances: 1,
  // The binary is named once, in the service options below. `tauri:options` is
  // the other place the service accepts it and is not in WebdriverIO's
  // capability types, so naming it twice would cost a cast and buy nothing.
  capabilities: [{ browserName: "tauri" }],
  services: [
    [
      "tauri",
      {
        appBinaryPath: app.binaryPath,
        driverProvider: "embedded",
        // `captureBackendLogs` / `captureFrontendLogs` and the whole
        // `browser.tauri.*` surface are left off: they need the companion
        // `tauri-plugin-wdio`, which evaluates scripts with `eval` inside the
        // page, and our CSP has no `'unsafe-eval'`. Turning it on would mean
        // testing an app with a weaker CSP than the one we ship.
      },
    ],
  ],
  framework: "mocha",
  reporters: ["spec"],
  logLevel: "warn",
  // A first scan of the fixture library decodes 22 files and then fingerprints
  // them, and a debug build is not a fast one. The per-spec timeout has to sit
  // above the longest wait inside a spec, or mocha kills the test before its own
  // timeoutMsg can say what it was waiting for.
  waitforTimeout: 30_000,
  mochaOpts: { ui: "bdd", timeout: 600_000 },
};
