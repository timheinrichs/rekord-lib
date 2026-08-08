import { useLayoutEffect, useRef } from "react";

/**
 * Replays a CSS animation on an element whenever `signature` changes.
 *
 * Used for the fade the track list plays when the filter, sorting or grouping
 * changes. Remounting via `key` would achieve the same but also reset the
 * virtualizer's scroll position and measured row heights, which shows up as a
 * jump — so the class is taken off, layout is forced, and it goes back on.
 *
 * Skips the very first run: the element already animates on mount through its
 * own class, and replaying it there would double the animation.
 */
export function useReplayAnimation<T extends HTMLElement>(
  signature: string,
  className = "animate-fade-in",
) {
  const ref = useRef<T>(null);
  const previous = useRef(signature);

  useLayoutEffect(() => {
    if (previous.current === signature) return;
    previous.current = signature;
    const el = ref.current;
    if (!el) return;
    el.classList.remove(className);
    // Reading a layout property flushes the removal, so re-adding the class
    // counts as a new animation rather than a no-op.
    void el.offsetWidth;
    el.classList.add(className);
  }, [signature, className]);

  return ref;
}
