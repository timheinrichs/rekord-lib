import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { severityOf, type Severity } from "./changelog";
import { devInstall, devUpdate } from "./devUpdate";

/** A pending update, reduced to what the UI needs. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes?: string;
  /**
   * `critical` when the release marked itself so in the changelog — a security
   * or data-loss fix, which the UI says loudly instead of quietly.
   */
  severity: Severity | null;
}

// The last checked update handle, so installUpdate() can apply it without
// re-checking.
let pending: Update | null = null;

/**
 * Checks the configured endpoint for a newer release.
 * Returns the update info, or `null` when up to date. Any error (no release
 * yet, offline, or running under `tauri dev` without an endpoint) is treated
 * as "up to date" so the UI never breaks.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // A dev run has no endpoint, so without this the dialog is unreachable until a
  // real release. Null unless REKORD_DEV_UPDATE is set, and dead code in a build.
  const mock = devUpdate();
  if (mock) {
    pending = null;
    return mock;
  }
  try {
    const update = await check();
    if (update) {
      pending = update;
      return {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body || undefined,
        // The notes are the release body, which is the changelog section for
        // this version — so the marker travels with the text people read.
        severity: severityOf(update.body),
      };
    }
    pending = null;
    return null;
  } catch {
    return null;
  }
}

/**
 * The update the start-up prompt should be showing, or null for no prompt.
 *
 * Returns the update rather than a boolean so the caller has something
 * non-nullable to hand the dialog.
 *
 * Four conditions, and each one is a bug someone would otherwise report: there
 * has to be an update; the prompt must not come back after it was answered (per
 * session — the next launch is the next chance to notice, which is the whole
 * point of prompting); it waits for the splash, or it lands on the launch
 * animation instead of the app; and it stays out of the way while settings are
 * open, where the same update is already offered.
 */
export function promptedUpdate(
  update: UpdateInfo | null,
  answered: boolean,
  splashGone: boolean,
  settingsOpen: boolean,
): UpdateInfo | null {
  if (answered || !splashGone || settingsOpen) return null;
  return update;
}

/**
 * Downloads and installs the last found update, reporting byte progress, then
 * relaunches the app. Throws if no update is pending.
 */
export async function installUpdate(
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
  // Same gate as the check above: what is on screen is the mock, so installing
  // it has to be the mock too, or the dialog would report "no update available"
  // for the update it is displaying.
  if (devUpdate()) return devInstall(onProgress);

  const update = pending;
  if (!update) throw new Error("No update available");

  let downloaded = 0;
  let total: number | null = null;
  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data.contentLength ?? null;
    } else if (event.event === "Progress") {
      downloaded += event.data.chunkLength;
    }
    onProgress?.(downloaded, total);
  });

  await relaunch();
}
