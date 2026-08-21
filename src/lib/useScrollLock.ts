import { useEffect } from "react";

/**
 * Holds the page still while a dialog is open.
 *
 * The library list scrolls with the window, so with a modal on screen the list
 * behind it kept moving under the wheel — the dialog stayed centred while its
 * context slid away, which reads as if the click had missed something.
 *
 * Counted rather than a boolean: a modal can open on top of another (the
 * duplicates list over the metadata editor), and the first one to close must not
 * hand the scroll back while the second is still there.
 */
let open = 0;
/** What `body` had before the first lock, restored when the last one goes. */
let previous = "";

function lock() {
  if (open++ > 0) return;
  previous = document.body.style.overflow;
  document.body.style.overflow = "hidden";
}

function unlock() {
  if (--open > 0) return;
  // Exactly what was there before, including "" for "no inline value".
  document.body.style.overflow = previous;
  previous = "";
  // A negative count would keep the page locked after the next dialog closes.
  open = Math.max(open, 0);
}

/** Locks the page scroll for as long as the calling component is mounted. */
export function useScrollLock(): void {
  useEffect(() => {
    lock();
    return unlock;
  }, []);
}
