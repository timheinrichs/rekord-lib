import { useEffect, useState } from "react";

/**
 * The media query `index.css` switches every animation off under.
 *
 * Named here as well as written there, because the CSS rule reaches classes and
 * this one reaches the things CSS cannot see — a canvas redrawing itself is
 * motion no `[class*="animate-"]` selector knows about.
 */
export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Whether the machine has asked for less motion, kept in step with the setting.
 *
 * A listener rather than a read at mount, for the same reason the theme has
 * one: the preference can change while the app is open, and a window that
 * keeps scrolling after it was switched on is the case the rule exists for.
 *
 * `matchMedia` is guarded because jsdom only has it in newer versions, and a
 * component test that draws no motion should not need it. Absent, the answer is
 * "no" — the same default the browser gives.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => query()?.matches ?? false);

  useEffect(() => {
    const mq = query();
    if (!mq) return;
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

function query(): MediaQueryList | null {
  return typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION_QUERY)
    : null;
}
