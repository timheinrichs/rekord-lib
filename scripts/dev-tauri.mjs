#!/usr/bin/env node
/**
 * The `tauri` npm script, so that `npm run tauri dev` cannot reach a real
 * collection.
 *
 * A dev run is not a read-only observer — the scan writes tempo tags, the
 * metadata editor rewrites them, conversion and delete move files to the trash —
 * and scanning a 2000-track library takes minutes every time. So `dev` gets:
 *
 * - the generated library from `dev-library.py` as its library folder,
 * - a `-devtest` bundle identifier, via a `--config` overlay rather than an edit
 *   to the tracked `tauri.conf.json`, which means its own database, settings and
 *   undo history, and the installed app can keep running alongside.
 *
 * Every other subcommand passes through untouched. `build` in particular must
 * never see the overlay, or it would produce a devtest bundle; the release
 * workflow uses tauri-action and does not come through here at all.
 *
 *   npm run tauri dev                      generated library, devtest identifier
 *   REKORD_DEV_FRESH=1 npm run tauri dev   rebuild it and wipe the devtest data
 *   REKORD_DEV_REAL=1 npm run tauri dev    your real settings, no overlay
 *   REKORD_DEV_UPDATE=1 npm run tauri dev  fake a pending update (=critical too)
 *   npm run tauri build                    untouched
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OVERLAY = join("src-tauri", "tauri.devtest.conf.json");
const LIBRARY = join(ROOT, ".dev", "library");

const args = process.argv.slice(2);
const isDev = args[0] === "dev";
const useReal = !!process.env.REKORD_DEV_REAL;

function run(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    ...options,
  });
}

if (isDev && !useReal) {
  const fresh = !!process.env.REKORD_DEV_FRESH;
  run("python3", [
    join("scripts", "dev-library.py"),
    LIBRARY,
    ...(fresh ? ["--force"] : []),
  ]);

  const identifier = JSON.parse(
    readFileSync(join(ROOT, OVERLAY), "utf8"),
  ).identifier;
  const dataDir = join(homedir(), "Library", "Application Support", identifier);
  if (fresh) {
    rmSync(dataDir, { recursive: true, force: true });
    console.log(`wiped ${dataDir}`);
  }

  // Seed the library folder so a first launch has one; everything else the
  // developer changed in the devtest instance — the tempo range, the target
  // format — is left as it was.
  mkdirSync(dataDir, { recursive: true });
  const storePath = join(dataDir, "rekord-lib.json");
  const store = existsSync(storePath)
    ? JSON.parse(readFileSync(storePath, "utf8"))
    : {};
  store.settings = { analyze_bpm: true, ...(store.settings ?? {}), library_dir: LIBRARY };
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`);

  console.log(`library: ${LIBRARY}`);
  console.log(`app data: ${dataDir}`);
  args.push("--config", OVERLAY);
} else if (isDev) {
  console.log("REKORD_DEV_REAL is set — running against your real app data");
}

// A dev run has no updater endpoint, so the update dialog is unreachable unless
// the frontend is told to fake one. Renamed on the way through because only
// `VITE_`-prefixed variables reach `import.meta.env`, and passed to every
// subcommand rather than just `dev` so it costs nothing to ignore elsewhere.
const env = { ...process.env };
if (process.env.REKORD_DEV_UPDATE) {
  env.VITE_DEV_UPDATE = process.env.REKORD_DEV_UPDATE;
  if (isDev) console.log(`faking an update: ${env.VITE_DEV_UPDATE}`);
}

// Resolved explicitly rather than from PATH: npm only puts node_modules/.bin
// there for its own scripts, and this has to work when run directly too.
const cli = join(ROOT, "node_modules", ".bin", "tauri");
const result = spawnSync(cli, args, { cwd: ROOT, stdio: "inherit", env });
process.exit(result.status ?? 1);
