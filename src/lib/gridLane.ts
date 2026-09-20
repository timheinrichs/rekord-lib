/**
 * The arithmetic behind the zoomed waveform: which slice of the track is on
 * screen, where a second sits in it, and where the beats are.
 *
 * Pure and here rather than inside the canvas, for the reason `CLAUDE.md` gives
 * and one more: an error of one beat is invisible in a drawing. A grid drawn a
 * beat late looks exactly like a grid drawn on time — it is still evenly spaced,
 * still lands on transients most of the time — and the only way to catch it is
 * to state the arithmetic somewhere it can be asserted against numbers.
 */

/** The slice of the track a lane is showing, in seconds. */
export interface LaneWindow {
  from: number;
  to: number;
}

/** A beat grid as the app stores one: a tempo, a phase, and a bar position. */
export interface Grid {
  /** Seconds from the start of the track to the anchor beat. */
  anchorSecs: number;
  bpm: number;
  /** Which beat of the bar the anchor is, 1..4. `Battito` in the export. */
  downbeat: number;
}

/** One beat line to draw. */
export interface Beat {
  secs: number;
  /** Which beat of the bar this is, 1..4. */
  ofBar: number;
  /** The bar it belongs to, counting the track's first bar as 1. */
  bar: number;
}

/**
 * How many seconds the lane shows at once, widest first.
 *
 * Stated as seconds across the window rather than as a zoom factor, because
 * that is the thing being chosen: at 128 BPM, 16 s is eight bars and 2 s is
 * four beats. A factor would mean the same setting showed a different amount of
 * music on a different window.
 */
export const ZOOM_SPANS = [32, 16, 8, 4, 2] as const;

/** Eight bars at 128 BPM — enough to see the phrase the beat sits in. */
export const DEFAULT_ZOOM_SPAN = 16;

/** The nearest span in the ladder, for a stored value that is no longer in it. */
export function nearestSpan(secs: number): number {
  return ZOOM_SPANS.reduce((best, s) =>
    Math.abs(s - secs) < Math.abs(best - secs) ? s : best,
  );
}

/**
 * The window the playhead sits in the middle of.
 *
 * Centred always, including at both ends of the track, where the window runs
 * past the audio and draws nothing there. The alternative — clamping the window
 * into `[0, duration]` so it stays full — moves the playhead off the centre for
 * the first and last half-span, and a playhead that is only sometimes in the
 * middle is one you have to look for. The empty margin says "this is the start"
 * more clearly than a full window with a cursor near its edge.
 */
export function laneWindow(nowSecs: number, spanSecs: number): LaneWindow {
  const half = spanSecs / 2;
  return { from: nowSecs - half, to: nowSecs + half };
}

/**
 * The window a reduced-motion lane shows: fixed pages, not a slide.
 *
 * `DESIGN.md` asks for every animation to be switched off under
 * `prefers-reduced-motion`, and a canvas that scrolls is motion its CSS rule
 * cannot reach. Paging keeps every piece of information — the playhead still
 * moves, inside a window that stands still and jumps on when it is left.
 */
export function pagedWindow(nowSecs: number, spanSecs: number): LaneWindow {
  const page = Math.floor(Math.max(0, nowSecs) / spanSecs);
  return { from: page * spanSecs, to: (page + 1) * spanSecs };
}

/** Where a moment in the track sits in a lane `width` pixels wide. */
export function xAtTime(secs: number, w: LaneWindow, width: number): number {
  const span = w.to - w.from;
  if (span <= 0) return 0;
  return ((secs - w.from) / span) * width;
}

/** The moment a pixel of the lane stands for. The inverse of [`xAtTime`]. */
export function timeAtX(x: number, w: LaneWindow, width: number): number {
  if (width <= 0) return w.from;
  return w.from + (x / width) * (w.to - w.from);
}

/**
 * The beats visible in `w`, in order.
 *
 * Counted from the anchor in both directions, so a grid whose anchor sits at
 * 0:30 still has beats before it — the first bars of a track are exactly where
 * an anchor placed by the detector usually is not. Beats outside the track
 * itself are left out: `duration` is where the audio stops, and a grid line
 * over nothing is a line that says there is a beat there.
 *
 * Bars are counted from the start of the *file*: the first bar the track has
 * any of is bar 1. Not from the anchor, which is where the detector put it —
 * `analysis.rs` measures its excerpt from 0:30, so on almost every track the
 * anchor is half a minute in and numbering from it would label the intro
 * `0, -1, -2 …`. Not from the start of the *music* either: nothing in the app
 * detects where a phrase begins, and a number that claimed to be the bar of the
 * song would be inventing one.
 */
export function beatsInWindow(
  w: LaneWindow,
  grid: Grid,
  durationSecs: number,
): Beat[] {
  if (!(grid.bpm > 0) || !Number.isFinite(grid.bpm)) return [];
  const period = 60 / grid.bpm;
  if (!Number.isFinite(period) || period <= 0) return [];
  const from = Math.max(w.from, 0);
  const to = Math.min(w.to, durationSecs);
  if (to < from) return [];
  // A window wider than the whole track at two beats a pixel is a solid block,
  // not a grid. The caller decides whether to draw at all; this only refuses to
  // build an unbounded array.
  const first = Math.ceil((from - grid.anchorSecs) / period);
  const last = Math.floor((to - grid.anchorSecs) / period);
  if (last < first) return [];
  // The bar the track's own first beat falls in, so that one is bar 1 wherever
  // the anchor happens to sit.
  const origin = barIndex(grid, Math.ceil(-grid.anchorSecs / period));
  const beats: Beat[] = [];
  for (let n = first; n <= last; n++) {
    // `downbeat` is 1..4 and says which beat of the bar the anchor is, so the
    // anchor's own offset within its bar is `downbeat - 1`.
    beats.push({
      secs: grid.anchorSecs + n * period,
      ofBar: mod(grid.downbeat - 1 + n, 4) + 1,
      bar: barIndex(grid, n) - origin + 1,
    });
  }
  return beats;
}

/** Which bar a beat is in, counted from the anchor's own and signed. */
function barIndex(grid: Grid, n: number): number {
  return Math.floor((grid.downbeat - 1 + n) / 4);
}

/** Euclidean remainder: `-1 % 4` is `-1` in JavaScript and `3` here. */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}
