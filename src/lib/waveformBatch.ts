import type { Waveform } from "../types";

/**
 * Collects the waveform requests of individual rows into one call.
 *
 * The library table is virtualised, so the rows that ask are the rows on screen
 * — about twenty. Each asking on its own would be twenty round trips for one
 * screenful, and scrolling would multiply that; each row asking a shared
 * batcher is one call per scroll position instead.
 *
 * A path that has no stored waveform is remembered as absent, so a track the
 * scan has not reached yet is not re-requested on every scroll. That memory is
 * cleared by `forget`, which is what a finished scan calls.
 */
export interface WaveformBatcher {
  /** The waveform for `path`, if it is already known. */
  get(path: string): Waveform | null | undefined;
  /**
   * Asks for `path` and calls `onLoaded` once the answer is in. Returns an
   * unsubscribe function — a row that scrolls out of view stops caring, and
   * calling back into an unmounted row is how React warnings start.
   */
  request(path: string, onLoaded: () => void): () => void;
  /** Drops what is known, so the next request asks again. */
  forget(): void;
}

export function createWaveformBatcher(
  fetch: (paths: string[]) => Promise<Record<string, Waveform>>,
  schedule: (run: () => void) => void = queueMicrotask,
): WaveformBatcher {
  // `null` means "asked, and there is none" — a different state from "not asked
  // yet" (undefined), and the reason a missing waveform is not re-fetched.
  const known = new Map<string, Waveform | null>();
  const listeners = new Map<string, Set<() => void>>();
  let pending = new Set<string>();
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const paths = [...pending];
    pending = new Set();
    if (!paths.length) return;
    void fetch(paths)
      .then((found) => {
        for (const path of paths) {
          known.set(path, found[path] ?? null);
        }
        notify(paths);
      })
      .catch(() => {
        // A failed read is not remembered as "absent": the next scroll past
        // this row should try again rather than leave a permanent blank.
        notify(paths);
      });
  };

  const notify = (paths: string[]) => {
    for (const path of paths) {
      for (const cb of listeners.get(path) ?? []) cb();
    }
  };

  return {
    get: (path) => known.get(path),

    request(path, onLoaded) {
      let set = listeners.get(path);
      if (!set) {
        set = new Set();
        listeners.set(path, set);
      }
      set.add(onLoaded);

      if (!known.has(path)) {
        pending.add(path);
        if (!scheduled) {
          scheduled = true;
          schedule(flush);
        }
      }

      return () => {
        set?.delete(onLoaded);
        if (set && set.size === 0) listeners.delete(path);
      };
    },

    forget() {
      known.clear();
    },
  };
}
