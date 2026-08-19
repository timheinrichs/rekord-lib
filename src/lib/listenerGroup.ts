/**
 * Collects Tauri event unsubscribers that arrive asynchronously.
 *
 * `listen()` returns its unsubscriber through a promise, so the plain pattern
 *
 *     let off: (() => void) | undefined;
 *     void (async () => { off = await listen(…); })();
 *     return () => off?.();
 *
 * leaks whenever cleanup runs before that promise settles: `off` is still
 * undefined, nothing is unsubscribed, and the handler stays live for the rest of
 * the session — firing stale closures from a component that is long gone. React
 * Fast Refresh makes it happen on every edit, which is how it was found: the
 * duplicates panel kept opening itself from a listener registered by a previous
 * version of the module.
 *
 * This closes the window by remembering that cleanup already happened, so a
 * late arrival unsubscribes itself immediately.
 */
export interface ListenerGroup {
  /** Takes an unsubscriber, or calls it at once if the group is already done. */
  add(off: () => void): void;
  /** Unsubscribes everything and refuses anything that arrives later. */
  dispose(): void;
}

export function listenerGroup(): ListenerGroup {
  let disposed = false;
  const offs: (() => void)[] = [];
  return {
    add(off) {
      if (disposed) off();
      else offs.push(off);
    },
    dispose() {
      disposed = true;
      // Splice as we go, so a second dispose() cannot unsubscribe twice.
      while (offs.length) offs.pop()?.();
    },
  };
}
