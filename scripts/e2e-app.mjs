#!/usr/bin/env node
/**
 * Build the app that `e2e/*.spec.ts` drives, in a state where driving it is
 * safe and repeatable.
 *
 * The e2e suite is the opposite of a read-only observer: it converts files,
 * writes tags and moves originals to the trash. So it never runs against a real
 * collection, and unlike `npm run tauri dev` it cannot be talked into it —
 * there is no `REKORD_DEV_REAL` here, deliberately. What it does:
 *
 * - regenerates the fixture library with `--force`. Without it a rerun inherits
 *   the previous run's writes: the BPM pass fills tempo tags, `write_metadata`
 *   rewrites them, a conversion trashes the source. `dev-library.py` leaves
 *   existing files alone on purpose, which is right for a dev run and wrong
 *   here.
 * - wipes the e2e app data directory, so every run starts with no database, no
 *   settings and no undo history.
 * - builds with a third bundle identifier (`-e2e`, from `tauri.e2e.conf.json`),
 *   next to the real app and the `-devtest` dev run. Three identifiers, three
 *   data directories, no overlap.
 * - builds a **debug** bundle with `--features wdio`. That combination is the
 *   only one that exists: the feature carries an HTTP automation server, and
 *   `lib.rs` refuses to compile it into a release.
 *
 * `scripts/dev-tauri.mjs` deliberately passes `build` through untouched, so this
 * is a separate entry point rather than another branch in there.
 *
 *   npm run e2e:build     build the e2e app and print its binary path
 *   npm run e2e           build, then run the suite (see wdio.conf.ts)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OVERLAY = join("src-tauri", "tauri.e2e.conf.json");
const LIBRARY = join(ROOT, ".dev", "e2e-library");
const TARGET = "aarch64-apple-darwin";

const overlay = JSON.parse(readFileSync(join(ROOT, OVERLAY), "utf8"));
const dataDir = join(homedir(), "Library", "Application Support", overlay.identifier);

/** The bundled app, and the binary inside it that WebDriver launches. */
export const appPath = join(
  ROOT,
  "src-tauri",
  "target",
  TARGET,
  "debug",
  "bundle",
  "macos",
  `${overlay.productName}.app`,
);
export const binaryPath = join(appPath, "Contents", "MacOS", "rekord-lib");
export const libraryPath = LIBRARY;

function run(command, args) {
  execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });
}

export function prepare() {
  run("python3", [join("scripts", "dev-library.py"), LIBRARY, "--force"]);

  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });

  // Seed the library folder and the analysis settings the specs assume. Unlike
  // the dev run there is nothing to preserve here — the directory was just
  // deleted — so this writes the whole store rather than merging into it.
  const store = { settings: { analyze_bpm: true, library_dir: LIBRARY } };
  writeFileSync(
    join(dataDir, "rekord-lib.json"),
    `${JSON.stringify(store, null, 2)}\n`,
  );

  console.log(`library:  ${LIBRARY}`);
  console.log(`app data: ${dataDir}`);
}

/**
 * Hand the resolved paths to `wdio.conf.ts`. Written rather than imported
 * because this file is `.mjs` and the config is TypeScript, and a second copy of
 * the path arithmetic on the other side is exactly the kind of mirror that
 * drifts. Its absence is also the check that the build ran at all.
 */
function writeManifest() {
  const manifest = join(ROOT, ".dev", "e2e-app.json");
  mkdirSync(dirname(manifest), { recursive: true });
  writeFileSync(
    manifest,
    `${JSON.stringify({ appPath, binaryPath, libraryPath: LIBRARY, dataDir }, null, 2)}\n`,
  );
  return manifest;
}

export function build() {
  const cli = join(ROOT, "node_modules", ".bin", "tauri");
  run(cli, [
    "build",
    "--debug",
    "--target",
    TARGET,
    "--features",
    "wdio",
    // Only the .app — a dmg would be built for nobody, and updater artifacts
    // need signing keys this build has no business touching.
    "--bundles",
    "app",
    "--config",
    OVERLAY,
  ]);
  if (!existsSync(binaryPath)) {
    throw new Error(`the build produced no binary at ${binaryPath}`);
  }
  console.log(`binary:   ${binaryPath}`);
  console.log(`manifest: ${writeManifest()}`);
}

// Only when run directly, so `wdio.conf.ts` can import the paths without
// triggering a build.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  prepare();
  build();
}
