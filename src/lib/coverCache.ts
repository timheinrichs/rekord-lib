/**
 * The thumbnails the library table draws, and what invalidates them.
 *
 * A cover is read out of the file and shrunk by the backend, which costs a
 * decode, so the table asks once per path and remembers the answer for as long
 * as the app runs. That memory used to be a bare `Map` in `CoverThumb` with
 * nothing to clear it: a write that changed or removed the artwork left the old
 * thumbnail on screen until the next launch, and a correct write looked like one
 * that had done nothing (roadmap C7).
 *
 * So the rule this module exists to state: **a thumbnail is valid until the file
 * behind it is written.** Three things do that — a tag write, an undo, and a
 * conversion — and a fourth changes it behind our back, which the scan reports
 * when it re-analyses the file. All four end in `forget`.
 *
 * Shaped after `waveformBatch.ts`, which solves the same problem for the other
 * artefact a row draws. Without the batching: `cover_thumbnail` answers one path
 * per call, so there is nothing to collect.
 */

export interface CoverCache {
  /**
   * The thumbnail for `path`: a data URL, `null` for "asked, and there is
   * none", `undefined` for "not asked yet". The middle case is what keeps a
   * coverless track from being re-read on every scroll.
   */
  get(path: string): string | null | undefined;
  /**
   * Asks for `path` and calls `onChanged` whenever the answer arrives or
   * changes. Returns an unsubscribe — a row that scrolls out of view stops
   * caring, and calling into an unmounted row is how React warnings start.
   */
  request(path: string, onChanged: () => void): () => void;
  /**
   * Drops what is known for these paths and asks again for the ones a row is
   * still showing.
   *
   * Both halves matter, and the second is the whole fix: a mounted row asked
   * once and will not ask again until it remounts, so clearing the entry alone
   * would leave exactly the stale image this is meant to replace. Paths nobody
   * is listening to are only dropped — the next row that scrolls past fetches
   * them.
   */
  forget(paths: string[]): void;
}

export function createCoverCache(
  fetch: (path: string) => Promise<string | null>,
): CoverCache {
  const known = new Map<string, string | null>();
  const listeners = new Map<string, Set<() => void>>();
  /** Paths with a request in flight, so two rows do not both ask. */
  const inFlight = new Set<string>();
  /**
   * Bumped by `forget`. A read that was already on its way describes the file
   * as it was *before* the write, so it has to be recognised as stale when it
   * lands — dropping it from `inFlight` alone would let it overwrite the fresh
   * answer, which is the same wrong image again by a longer route.
   */
  const epoch = new Map<string, number>();
  /**
   * Reads that failed, per path. A backend that cannot decode this file's
   * artwork will not manage it on the next scroll either, and the table is
   * virtualised, so a row that keeps coming back would keep asking. After
   * `MAX_ATTEMPTS` the path is remembered as coverless until something forgets
   * it — a write, which is the only thing that could change the answer anyway.
   */
  const failures = new Map<string, number>();
  const MAX_ATTEMPTS = 2;

  const notify = (path: string) => {
    for (const cb of listeners.get(path) ?? []) cb();
  };

  const load = (path: string) => {
    if (inFlight.has(path)) return;
    inFlight.add(path);
    const asked = epoch.get(path) ?? 0;
    const settle = (store?: () => void) => {
      if ((epoch.get(path) ?? 0) !== asked) return;
      inFlight.delete(path);
      store?.();
      notify(path);
    };
    void fetch(path)
      .then((url) =>
        settle(() => {
          failures.delete(path);
          known.set(path, url);
        }),
      )
      // A first failure is not remembered as "no cover" — it may be a hiccup,
      // and the next row that asks should try again. A repeated one is.
      .catch(() =>
        settle(() => {
          const tries = (failures.get(path) ?? 0) + 1;
          failures.set(path, tries);
          if (tries >= MAX_ATTEMPTS) known.set(path, null);
        }),
      );
  };

  return {
    get: (path) => known.get(path),

    request(path, onChanged) {
      let set = listeners.get(path);
      if (!set) {
        set = new Set();
        listeners.set(path, set);
      }
      set.add(onChanged);
      if (!known.has(path)) load(path);

      return () => {
        set?.delete(onChanged);
        if (set && set.size === 0) listeners.delete(path);
      };
    },

    forget(paths) {
      for (const path of paths) {
        known.delete(path);
        failures.delete(path);
        epoch.set(path, (epoch.get(path) ?? 0) + 1);
        inFlight.delete(path);
        if (listeners.has(path)) load(path);
      }
    },
  };
}
