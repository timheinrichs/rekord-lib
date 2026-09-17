import {
  STAGE_ANALYZING,
  STAGE_BPM,
  STAGE_BPM_KEY,
  STAGE_DUPLICATES,
  STAGE_KEY,
  type ScanProgress,
} from "../types";

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
 * The running scan in one line. The analysis pass decodes every file and runs
 * for minutes, so it reports its counters rather than a generic "scanning".
 * Also used by the rescan button, which is why it lives here.
 */
export function scanLabel(progress?: ScanProgress | null): string {
  const label = stageLabel(progress);
  if (!progress?.paused) return label;
  // Paused is a state, not a stage, so it keeps the counters in view — they say
  // where the run will pick up. Where there are none yet, it stands alone
  // rather than reading as "Paused · Scanning…".
  return label.endsWith("…") ? "Scan paused" : `Paused · ${label}`;
}

function stageLabel(progress?: ScanProgress | null): string {
  if (!progress) return "Scanning…";
  // The analysis pass reports what it is actually doing: a fresh library needs
  // both values, one another program has tagged needs only the key.
  const analysis: Record<string, string> = {
    [STAGE_BPM]: "BPM",
    [STAGE_KEY]: "Key",
    [STAGE_BPM_KEY]: "BPM/Key",
  };
  const what = analysis[progress.stage];
  if (what) {
    return `${what} ${progress.done}/${progress.total}`;
  }
  // The duplicate phase counts the files it has to fingerprint, which is a
  // subset of the library and often zero once the cache is warm — so it only
  // shows numbers when there is work to count.
  if (progress.stage === STAGE_DUPLICATES) {
    return progress.total > 0
      ? `Duplicates ${progress.done}/${progress.total}`
      : "Finding duplicates…";
  }
  if (progress.total > 0) {
    return `Analyzing ${progress.done}/${progress.total}`;
  }
  return "Scanning…";
}

/**
 * What a screen reader is told a scan is doing.
 *
 * Deliberately not `scanLabel`: that carries the counters, which change on every
 * file, and a polite live region that re-announces "BPM 43 of 1200" once a
 * second is worse than silence. This changes only when the *stage* does, so the
 * announcements are "Detecting BPM", then "Finding duplicates", then done —
 * about four for a run that takes minutes.
 *
 * Returns null when there is nothing to say, so the region can render empty
 * rather than announcing a scan that is not running.
 */
export function scanAnnouncement(
  progress: ScanProgress | null | undefined,
  running: boolean,
  finished: boolean,
): string | null {
  if (finished && !running) return "Scan finished";
  if (!running) return null;
  if (progress?.paused) return "Scan paused";
  const stage = progress?.stage;
  if (!stage) return "Scanning";
  // The stage constants are already written as words a person would read, so
  // there is no second table of labels to keep in step with them.
  return stage === STAGE_ANALYZING ? "Analyzing files" : stage;
}

/**
 * Which of its four faces the scan button shows.
 *
 * Derived in one place on purpose: the colour and the content used to branch on
 * separate conditions, which let them disagree — a green outline around a
 * spinner, because a finished run had already queued the next pass. A run in
 * progress always wins over a pending confirmation, and a paused run is a
 * distinct face because the button's *action* changes with it: it holds the run
 * while one is going, and lets it continue while one is held.
 */
export type ScanButtonState = "busy" | "paused" | "finished" | "idle";

export function scanButtonState(
  busy: boolean,
  finished: boolean,
  paused = false,
): ScanButtonState {
  if (busy) return paused ? "paused" : "busy";
  // Paused only means anything while a run exists to hold.
  return finished ? "finished" : "idle";
}
