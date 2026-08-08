import { STAGE_BPM, type ScanProgress } from "../types";

/**
 * How far the app is into starting up. The splash is shown for everything but
 * "ready" — and "ready" means the library is displayable, not that the scan has
 * finished: a first scan runs for minutes, which is far too long to hold a
 * splash. From then on the table's own loading state takes over.
 */
export type BootPhase = "starting" | "library" | "scanning" | "ready";

/**
 * What the splash says beneath the logo. Sentence case, no trailing ellipsis
 * on the counted variants — the numbers already show that something is moving.
 */
export function bootLabel(
  phase: BootPhase,
  progress?: ScanProgress | null,
): string {
  switch (phase) {
    case "starting":
      return "Starting app…";
    case "library":
      return "Loading library…";
    case "scanning":
      return scanLabel(progress);
    default:
      return "";
  }
}

/**
 * The running scan in one line. The BPM pass decodes every file and runs for
 * minutes, so it reports its counters rather than a generic "scanning".
 * Also used by the rescan button, which is why it lives here.
 */
export function scanLabel(progress?: ScanProgress | null): string {
  if (!progress) return "Scanning…";
  if (progress.stage === STAGE_BPM) {
    return `BPM ${progress.done}/${progress.total}`;
  }
  if (progress.total > 0) {
    return `Analyzing ${progress.done}/${progress.total}`;
  }
  return "Scanning…";
}
