import type { Waveform } from "../types";

/**
 * A bounded cache of waveform overviews, keyed by path.
 *
 * It holds **promises**, not values, which is the point: skipping back and forth
 * between two tracks would otherwise start the same full-track decode twice, and
 * the second one would be pure waste. A caller that arrives while a decode is in
 * flight awaits the same promise.
 *
 * Bounded because a waveform is ~19 KB and a long session touches a lot of
 * tracks. Least-recently-used goes first — the pattern this serves is going back
 * to something played a moment ago.
 *
 * Session-scoped on purpose: nothing on disk, so there is no invalidation
 * contract to keep honest. A file that changes while the app is open is the one
 * case this gets wrong, and it is worth that — the alternative is ~40 MB of
 * database for a sub-second saving on a replay.
 */
export interface WaveformCache {
  /** The cached or in-flight waveform for `path`, computing it if needed. */
  get(path: string, compute: (path: string) => Promise<Waveform>): Promise<Waveform>;
  /** Drops an entry, so the next request recomputes it. */
  forget(path: string): void;
  size(): number;
}

export function createWaveformCache(limit = 24): WaveformCache {
  const entries = new Map<string, Promise<Waveform>>();

  return {
    get(path, compute) {
      const hit = entries.get(path);
      if (hit) {
        // Re-insert so this counts as the most recently used.
        entries.delete(path);
        entries.set(path, hit);
        return hit;
      }
      const pending = compute(path).catch((e) => {
        // A failed decode must not be cached as a permanent answer: the file may
        // simply have been busy, and a retry costs one decode.
        entries.delete(path);
        throw e;
      });
      entries.set(path, pending);
      while (entries.size > limit) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return pending;
    },

    forget(path) {
      entries.delete(path);
    },

    size() {
      return entries.size;
    },
  };
}
