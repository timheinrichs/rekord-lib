import { useEffect, useRef } from "react";

/**
 * Calls `onFrame` with the player's position, once a frame, while `enabled`.
 *
 * The app's only `requestAnimationFrame` loop, and deliberately the only one: a
 * leaked frame loop is a permanent 60 Hz wakeup on a laptop, costing battery for
 * a window nobody is looking at. One hook, one cancel path, and a test that the
 * cancel happens.
 *
 * It never calls `setState`. The position it reads updates sixty times a second
 * and the thing that draws it is a canvas, so putting it through React would
 * re-render a tree per frame to produce no DOM change at all — which is also why
 * the player keeps its position in a context of its own (`ProgressCtx`) at a
 * quarter of that rate for the things that *are* DOM.
 *
 * `onFrame` is held in a ref so that a consumer re-rendering with a new closure
 * does not tear the loop down and start another one.
 */
export function usePlayhead(
  enabled: boolean,
  read: () => number,
  onFrame: (secs: number) => void,
): void {
  const latest = useRef(onFrame);
  latest.current = onFrame;
  const reader = useRef(read);
  reader.current = read;

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const tick = () => {
      latest.current(reader.current());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [enabled]);
}
