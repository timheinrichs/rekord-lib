import { useCallback, useEffect, useRef } from "react";

import { drawLane, laneColours, type LaneFrame } from "../lib/gridCanvas";
import {
  beatsInWindow,
  laneWindow,
  pagedWindow,
  timeAtX,
  type Grid,
  type LaneWindow,
} from "../lib/gridLane";
import { usePlayer, usePlayerProgress } from "../lib/player";
import { usePlayhead } from "../lib/usePlayhead";
import { useReducedMotion } from "../lib/useReducedMotion";
import type { Waveform } from "../types";

/** How tall the lane is, in CSS pixels, ruler included. */
export const LANE_HEIGHT = 160;

interface Props {
  /** The whole track's bins — the detail array where one has arrived. */
  data: Waveform;
  durationSecs: number;
  /** The beat grid, or `null` for a track that has none. */
  grid: Grid | null;
  /** How many seconds the lane shows at once. */
  spanSecs: number;
  /** Seek to a moment in the track. */
  onSeek: (secs: number) => void;
}

/**
 * The zoomed waveform, with the beat grid on it and the playhead through it.
 *
 * Two implementations, picked by the machine's motion preference, sharing one
 * drawing function. `DESIGN.md` requires every animation to be switched off
 * under `prefers-reduced-motion`, and the rule that does it in CSS
 * (`[class*="animate-"]`) cannot reach a canvas that redraws itself — so under
 * that preference the scrolling one is simply not mounted. What the other shows
 * is the same information: the playhead still moves, in a window that stands
 * still and jumps on when it is left.
 *
 * Two components rather than one with a branch, because the difference is
 * *which hook runs*: one subscribes to the frame clock, the other to the
 * player's four-times-a-second progress. A conditional hook is not allowed, and
 * subscribing to both would put the cost of the slow path on the fast one.
 */
export default function GridLane(props: Props) {
  return useReducedMotion() ? (
    <SteppedLane {...props} />
  ) : (
    <ScrollingLane {...props} />
  );
}

function ScrollingLane(props: Props) {
  const { playing, currentTime } = usePlayer();
  const { time } = usePlayerProgress();
  const { canvas, paint } = useLane(props, laneWindow);
  // A frame loop only while there is movement to draw. Paused, the last frame
  // is already right, and a loop would be sixty wakeups a second to redraw it.
  usePlayhead(playing, currentTime, paint);
  // Paused, the frame clock is the wrong one to listen to and there is still
  // one thing that moves: a seek. From the bar, or from a click on this very
  // lane. Without this the playhead stays where it was until playback resumes,
  // while the bar's own waveform — which reads this same progress — has already
  // moved, and the two disagree on screen.
  useEffect(() => {
    if (!playing) paint(time);
  }, [playing, time, paint]);
  return canvas;
}

function SteppedLane(props: Props) {
  const { time } = usePlayerProgress();
  const { canvas, paint } = useLane(props, pagedWindow);
  useEffect(() => paint(time), [paint, time]);
  return canvas;
}

/**
 * Everything the two lanes share: the canvas, the palette, the click target,
 * and one `paint` that takes a position and draws it.
 */
function useLane(
  { data, durationSecs, grid, spanSecs, onSeek }: Props,
  windowAt: (nowSecs: number, spanSecs: number) => LaneWindow,
) {
  const { currentTime } = usePlayer();
  const ref = useRef<HTMLCanvasElement | null>(null);
  /** The window the last frame drew, so a click lands where it looks. */
  const shown = useRef<LaneWindow>({ from: 0, to: spanSecs });

  const paint = useCallback(
    (nowSecs: number) => {
      const el = ref.current;
      if (!el) return;
      const w = windowAt(nowSecs, spanSecs);
      shown.current = w;
      const frame: LaneFrame = {
        data,
        durationSecs,
        window: w,
        nowSecs,
        beats: grid ? beatsInWindow(w, grid, durationSecs) : [],
        colours: laneColours(el),
      };
      drawLane(el, frame);
      // Set here rather than rendered, for the same reason the drawing is: this
      // is current sixty times a second, and React would re-render the surface
      // around it to change one attribute. A slider has to say where it is, and
      // a value that only updated when something else did would be worse than
      // none.
      el.setAttribute("aria-valuenow", String(Math.round(nowSecs)));
    },
    [data, durationSecs, grid, spanSecs, windowAt],
  );

  // Redraw whatever changed that is not the clock: new bins, a new zoom, a grid
  // that moved, the window resized.
  useEffect(() => paint(currentTime()), [paint, currentTime]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(() => paint(currentTime()));
    ro.observe(el);
    return () => ro.disconnect();
  }, [paint, currentTime]);

  const seekAt = (clientX: number) => {
    const el = ref.current;
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (!box.width) return;
    const secs = timeAtX(clientX - box.left, shown.current, box.width);
    onSeek(Math.min(Math.max(secs, 0), durationSecs));
  };

  const canvas = (
    <canvas
      ref={ref}
      onClick={(e) => seekAt(e.clientX)}
      style={{ height: LANE_HEIGHT }}
      className="w-full cursor-pointer rounded-md bg-surface-2"
      role="slider"
      // Distinct from the player bar's, which is on screen at the same time and
      // seeks the same track: that one is the whole of it, this one is a window
      // on it.
      aria-label="Seek, zoomed view"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationSecs)}
      aria-valuenow={0}
    />
  );

  return { canvas, paint };
}
