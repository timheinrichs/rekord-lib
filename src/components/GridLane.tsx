import { useCallback, useEffect, useRef } from "react";

import {
  drawLane,
  laneColours,
  type LaneColours,
  type LaneFrame,
} from "../lib/gridCanvas";
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
  /**
   * What a pointer on the lane does. A visible mode rather than a modifier:
   * a modifier is undiscoverable, and it would mean a scrub could nudge
   * somebody's grid by accident.
   */
  mode?: "seek" | "grid";
  /** How far the grid has been dragged so far, live, while a drag is running. */
  onGridDrag?: (deltaSecs: number) => void;
  /** The drag is over and the offset it ended on is the one to keep. */
  onGridDrop?: () => void;
  /** Escape, or a pointer the browser took away. Put the grid back. */
  onGridCancel?: () => void;
  /**
   * Whether the lane is actually on screen.
   *
   * The surface stays mounted while the settings are over it — that is what
   * lets it notice the player being closed — and `display: none` stops nothing.
   * Without this the frame loop keeps running at sixty wakeups a second for a
   * canvas whose `clientWidth` is zero, which is exactly what `usePlayhead`'s
   * own comment warns about.
   */
  visible?: boolean;
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
  usePlayhead(playing && props.visible !== false, currentTime, paint);
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
  // Gated for the same reason the frame loop is, four times a second instead of
  // sixty: a canvas behind `display: none` is zero pixels wide and every one of
  // these is work against nothing.
  useEffect(() => {
    if (props.visible !== false) paint(time);
  }, [props.visible, paint, time]);
  return canvas;
}

/** The palette for the theme now on `<html>`, re-read only when that changes. */
function coloursFor(
  el: HTMLElement,
  cache: { current: { theme?: string; colours: LaneColours } | null },
): LaneColours {
  const theme = document.documentElement.dataset.theme;
  if (!cache.current || cache.current.theme !== theme) {
    cache.current = { theme, colours: laneColours(el) };
  }
  return cache.current.colours;
}

/**
 * Everything the two lanes share: the canvas, the palette, the click target,
 * and one `paint` that takes a position and draws it.
 */
function useLane(
  {
    data,
    durationSecs,
    grid,
    spanSecs,
    onSeek,
    mode = "seek",
    onGridDrag,
    onGridDrop,
    onGridCancel,
  }: Props,
  windowAt: (nowSecs: number, spanSecs: number) => LaneWindow,
) {
  const { currentTime } = usePlayer();
  const ref = useRef<HTMLCanvasElement | null>(null);
  /** The window the last frame drew, so a click lands where it looks. */
  const shown = useRef<LaneWindow>({ from: 0, to: spanSecs });
  /**
   * The palette, and the theme it was read for.
   *
   * `laneColours` calls `getComputedStyle`, which forces a style recalculation
   * — sixty times a second, over a document that still has the whole library
   * table in it behind this surface. The tokens only change when the theme
   * does, and `applyTheme` writes that onto `<html>` as an attribute, which is
   * a string comparison rather than a layout question.
   */
  const palette = useRef<{ theme?: string; colours: LaneColours } | null>(null);
  /**
   * The running drag's teardown, so unmounting mid-drag takes its four window
   * listeners with it. Closing the player while the pointer is down unmounts
   * this surface, and a listener that outlived it would commit the next
   * `pointerup` anywhere in the app into a component that is gone.
   */
  const running = useRef<((commit: boolean) => void) | null>(null);
  useEffect(() => () => running.current?.(false), []);

  const paint = useCallback(
    (nowSecs: number) => {
      const el = ref.current;
      if (!el) return;
      const w = windowAt(nowSecs, spanSecs);
      shown.current = w;
      const frame: LaneFrame = {
        data,
        durationSecs,
        // The decoded span where the bins brought one, the probed duration
        // where they did not — a stored overview is read back beside a row that
        // already knows how long its track is.
        binsSpanSecs: data.duration_secs ?? durationSecs,
        window: w,
        nowSecs,
        beats: grid ? beatsInWindow(w, grid, durationSecs) : [],
        colours: coloursFor(el, palette),
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

  const timeAt = (clientX: number): number | null => {
    const el = ref.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    if (!box.width) return null;
    return timeAtX(clientX - box.left, shown.current, box.width);
  };

  const seekAt = (clientX: number) => {
    const secs = timeAt(clientX);
    if (secs == null) return;
    onSeek(Math.min(Math.max(secs, 0), durationSecs));
  };

  /**
   * Dragging the grid.
   *
   * Listened for on the *window* rather than on the canvas, which is the lesson
   * the playlist reorder already paid for: a pointer that leaves the element —
   * and at the edge of a lane it will — stops delivering moves to it, and the
   * drag ends wherever the element happened to be. Escape abandons, because a
   * grid put back is cheaper than a grid you have to find again.
   */
  const startDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    // The primary button only. A right-click would otherwise start a drag that
    // the context menu never ends, and its `pointerup` would commit one.
    if (e.button !== 0 || mode !== "grid" || !onGridDrag) return;
    const from = timeAt(e.clientX);
    if (from == null) return;
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const to = timeAt(ev.clientX);
      if (to != null) onGridDrag(to - from);
    };
    const stop = (commit: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
      running.current = null;
      if (commit) onGridDrop?.();
      else onGridCancel?.();
    };
    const up = () => stop(true);
    const cancel = () => stop(false);
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") stop(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    running.current = stop;
  };

  const canvas = (
    <canvas
      ref={ref}
      onPointerDown={startDrag}
      onClick={(e) => mode !== "grid" && seekAt(e.clientX)}
      style={{ height: LANE_HEIGHT }}
      className={`w-full rounded-md bg-surface-2 ${
        mode === "grid" ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
      }`}
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
