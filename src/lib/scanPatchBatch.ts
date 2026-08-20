import type { TrackPatch } from "../types";

/**
 * Collects the scan's per-file results into one list update per window.
 *
 * The tempo pass reports every file the moment it is finished, which is the
 * point — a row fills in while the run is going. But the library table has no
 * memoised rows: one `setTracks` rebuilds every row's markup, re-derives the
 * filter, the sort and the grouping, and re-measures every row height. At eight
 * workers that would be several full passes per second on a large library.
 *
 * So the results are gathered and handed over on a fixed window instead. Four
 * updates a second still reads as "filling in", and it costs the same whether
 * the analysis produces two files a second or twenty.
 */
export const PATCH_WINDOW_MS = 250;

export interface PatchCollector {
  /** Takes one result; the flush that carries it may be up to a window away. */
  add(patch: TrackPatch): void;
  /** Hands over whatever is waiting, right now. */
  flush(): void;
  /** Drops a pending flush — for an unmount, so nothing calls back into it. */
  stop(): void;
}

/**
 * `apply` receives one merged patch per path, in arrival order. `schedule` is
 * injectable so tests do not have to wait out a real window.
 */
export function createPatchCollector(
  apply: (patches: TrackPatch[]) => void,
  windowMs: number = PATCH_WINDOW_MS,
  schedule: (run: () => void, ms: number) => () => void = (run, ms) => {
    const id = setTimeout(run, ms);
    return () => clearTimeout(id);
  },
): PatchCollector {
  // Keyed by path: two results for the same file inside one window (a forced
  // re-analysis, a retry) collapse instead of updating the row twice.
  let waiting = new Map<string, TrackPatch>();
  let cancel: (() => void) | null = null;

  const flush = () => {
    cancel = null;
    if (!waiting.size) return;
    const batch = [...waiting.values()];
    waiting = new Map();
    apply(batch);
  };

  return {
    add(patch) {
      const before = waiting.get(patch.path);
      waiting.set(patch.path, before ? merge(before, patch) : patch);
      if (!cancel) cancel = schedule(flush, windowMs);
    },

    flush() {
      cancel?.();
      flush();
    },

    stop() {
      cancel?.();
      cancel = null;
      waiting = new Map();
    },
  };
}

/**
 * Two results for the same path, folded into one. The newer value wins per
 * field, but only where it has one — the older patch may be the only one that
 * carried the waveform.
 */
function merge(older: TrackPatch, newer: TrackPatch): TrackPatch {
  return {
    path: newer.path,
    bpm: newer.bpm ?? older.bpm,
    bpm_confidence:
      newer.bpm != null ? newer.bpm_confidence : older.bpm_confidence,
    key: newer.key ?? older.key,
    key_camelot: newer.key != null ? newer.key_camelot : older.key_camelot,
    key_confidence: newer.key != null ? newer.key_confidence : older.key_confidence,
    waveform: older.waveform || newer.waveform,
  };
}

/** The paths a batch stored a waveform for. */
export function waveformPaths(patches: TrackPatch[]): string[] {
  return patches.filter((p) => p.waveform).map((p) => p.path);
}
