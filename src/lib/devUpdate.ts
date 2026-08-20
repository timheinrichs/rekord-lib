import type { UpdateInfo } from "./updater";
import { severityOf } from "./changelog";

/**
 * A fake pending update, for looking at the update dialog in `tauri dev`.
 *
 * There is no updater endpoint in a dev run, so the real check always answers
 * "up to date" and the dialog cannot be reached — which is exactly the piece of
 * UI that only becomes visible on a real release otherwise. Set
 * `REKORD_DEV_UPDATE=1` and the check answers with this instead; `=critical` or
 * `=important` fakes that level, so both markers can be looked at.
 *
 * Guarded by `import.meta.env.DEV`, so the whole thing is dead code in a release
 * build even if the variable were somehow set.
 */

/** Deliberately unmistakable: nobody should mistake this for a real release. */
const NOTES = `**Dev mock** — this update does not exist. Set by \`REKORD_DEV_UPDATE\`.

### Fixed
- **A tempo written into the wrong file.** A rename that landed between the scan
  and the tag write sent the value to whichever file had taken the old path.
- The waveform of a track shorter than three seconds no longer draws past its row.

### Changed
- Duplicate groups keep the copy with the better format rather than the first one
  found.`;

/** The mock update, or null when the variable is unset (or this is a build). */
export function devUpdate(): UpdateInfo | null {
  if (!import.meta.env.DEV) return null;
  const flag = import.meta.env.VITE_DEV_UPDATE;
  if (!flag) return null;
  return {
    version: "0.99.0",
    currentVersion: "0.7.0",
    notes: NOTES,
    // The flag doubles as the level, so `=1` is the ordinary case and anything
    // the parser does not know is ordinary too — same rule as a real release.
    severity: severityOf(`**Severity:** ${flag}`),
  };
}

/**
 * Stands in for the install. Ramps the progress so that state is visible too,
 * then fails on purpose: there is no artifact to apply and pretending otherwise
 * would end in a relaunch that changes nothing.
 */
export async function devInstall(
  onProgress?: (downloaded: number, total: number | null) => void,
  step: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<never> {
  const total = 42_000_000;
  for (let done = 0; done <= total; done += total / 8) {
    onProgress?.(done, total);
    await step(120);
  }
  throw new Error("dev mock — there is nothing to install");
}
