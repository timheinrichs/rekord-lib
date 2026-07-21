import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** A pending update, reduced to what the UI needs. */
export interface UpdateInfo {
  version: string;
  currentVersion: string;
  notes?: string;
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
  try {
    const update = await check();
    if (update) {
      pending = update;
      return {
        version: update.version,
        currentVersion: update.currentVersion,
        notes: update.body || undefined,
      };
    }
    pending = null;
    return null;
  } catch {
    return null;
  }
}

/**
 * Downloads and installs the last found update, reporting byte progress, then
 * relaunches the app. Throws if no update is pending.
 */
export async function installUpdate(
  onProgress?: (downloaded: number, total: number | null) => void,
): Promise<void> {
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
