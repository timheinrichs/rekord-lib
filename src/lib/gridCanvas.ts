import { accent, font } from "../styles/theme";
import type { Waveform } from "../types";
import { xAtTime, type Beat, type LaneWindow } from "./gridLane";

/**
 * Drawing the zoomed lane: the waveform under the window, the beat grid over
 * it, the ruler above it and the playhead through all three.
 *
 * Imperative and outside React on purpose. This runs once a frame against the
 * audio clock, and what it produces is pixels, not DOM — putting it through
 * state would re-render a tree sixty times a second to change nothing. The
 * arithmetic it draws from is in `gridLane.ts`, where it can be asserted
 * against numbers; this file is the part a test can only look at.
 *
 * Both variants of the lane — the one that scrolls and the one that pages under
 * `prefers-reduced-motion` — call this same function. They differ in the window
 * they hand it and in how often, which is the whole of the difference.
 */

/** Height of the strip above the waveform that carries the bar numbers. */
export const RULER_PX = 14;

export interface LaneColours {
  peak: string;
  rms: string;
  playedPeak: string;
  playedRms: string;
  beat: string;
  downbeat: string;
  playhead: string;
  ruler: string;
}

/**
 * The lane's palette, from the tokens.
 *
 * The same trick `Waveform.tsx` uses and for the same reason — a canvas cannot
 * take a Tailwind class — with one addition it needs and the bar does not: the
 * grid. `DESIGN.md` names graphite for the lines under the canvas waveform and
 * `accent-300` for an informational marker, so a plain beat is the quiet one
 * and a downbeat is the one that says something. The playhead takes `fg`,
 * because it must not be mistaken for either the signal or the grid.
 */
export function laneColours(el: HTMLElement): LaneColours {
  const css = getComputedStyle(el);
  const token = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  return {
    peak: token("--border-strong", "#343440"),
    rms: token("--fg-subtle", "#8C8C98"),
    playedPeak: accent[800],
    playedRms: accent[500],
    beat: token("--border-strong", "#343440"),
    downbeat: accent[300],
    playhead: token("--fg", "#F6F6F8"),
    ruler: token("--fg-subtle", "#8C8C98"),
  };
}

export interface LaneFrame {
  /** The whole track's bins — the detail array where there is one. */
  data: Waveform;
  durationSecs: number;
  window: LaneWindow;
  /** Where the playhead is, in seconds. */
  nowSecs: number;
  beats: Beat[];
  colours: LaneColours;
}

/**
 * Draws one frame of the lane into `canvas` at its current size.
 *
 * One column per device pixel, as the player bar's waveform does, but reading a
 * *slice* of the bins rather than all of them: at the deepest zoom a column is
 * a fraction of a bin, so a column takes the loudest of however many bins fall
 * into it and a bin that spans several columns is drawn by each of them. That
 * is the data, and stopping where the data stops is more honest than smoothing
 * a curve through it.
 *
 * Four paths and four fills, rather than a `fillRect` per column: a fill per
 * column is four thousand state changes a frame at the widest zoom on a retina
 * display. If that ever stops being enough — the number to watch is the frame
 * budget in a real window, not in jsdom — the next step is an offscreen tile
 * three windows wide, rebuilt when the playhead has travelled half a window,
 * which turns the column loop from once a frame into once every few seconds.
 */
export function drawLane(canvas: HTMLCanvasElement, frame: LaneFrame): void {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const { colours: c, window: w, data, durationSecs, nowSecs } = frame;
  const ruler = Math.round(RULER_PX * ratio);
  const waveTop = ruler;
  const waveHeight = Math.max(1, height - ruler);
  const middle = waveTop + waveHeight / 2;

  ctx.clearRect(0, 0, width, height);

  if (data.peak.length && durationSecs > 0) {
    const played = new Path2D();
    const playedRms = new Path2D();
    const rest = new Path2D();
    const restRms = new Path2D();
    const bins = data.peak.length;
    const perSec = bins / durationSecs;

    for (let x = 0; x < width; x++) {
      const from = xToTime(x, w, width);
      const to = xToTime(x + 1, w, width);
      if (to <= 0 || from >= durationSecs) continue;
      const first = clampIndex(Math.floor(Math.max(from, 0) * perSec), bins);
      const last = clampIndex(Math.ceil(Math.min(to, durationSecs) * perSec), bins);
      let peak = 0;
      let rms = 0;
      for (let b = first; b <= last; b++) {
        if (data.peak[b] > peak) peak = data.peak[b];
        if (data.rms[b] > rms) rms = data.rms[b];
      }
      // At least a pixel, so silence is a line rather than a hole — the same
      // floor the bar's waveform keeps, and for the same reason.
      const ph = Math.max(1, peak * (waveHeight / 2));
      const rh = Math.max(1, rms * (waveHeight / 2));
      const before = to <= nowSecs;
      (before ? played : rest).rect(x, middle - ph, 1, ph * 2);
      (before ? playedRms : restRms).rect(x, middle - rh, 1, rh * 2);
    }

    ctx.fillStyle = c.peak;
    ctx.fill(rest);
    ctx.fillStyle = c.rms;
    ctx.fill(restRms);
    ctx.fillStyle = c.playedPeak;
    ctx.fill(played);
    ctx.fillStyle = c.playedRms;
    ctx.fill(playedRms);
  }

  // The grid over the waveform, because it is a statement *about* it.
  const line = Math.max(1, Math.round(ratio));
  const beatPath = new Path2D();
  const barPath = new Path2D();
  for (const beat of frame.beats) {
    const x = Math.round(xAtTime(beat.secs, w, width));
    if (x < 0 || x > width) continue;
    // A downbeat runs the full height, through the ruler, and a plain beat
    // starts below it: the difference is visible at a glance without reading a
    // number, which is what makes a mis-set anchor findable.
    (beat.ofBar === 1 ? barPath : beatPath).rect(
      x,
      beat.ofBar === 1 ? 0 : waveTop,
      line,
      beat.ofBar === 1 ? height : waveHeight,
    );
  }
  ctx.fillStyle = c.beat;
  ctx.fill(beatPath);
  ctx.fillStyle = c.downbeat;
  ctx.fill(barPath);

  drawBarNumbers(ctx, frame, width, ratio);

  // The playhead last, so nothing is drawn over the one thing that has to stay
  // findable.
  const head = Math.round(xAtTime(nowSecs, w, width));
  if (head >= 0 && head <= width) {
    ctx.fillStyle = c.playhead;
    ctx.fillRect(head, 0, Math.max(1, Math.round(2 * ratio)), height);
  }
}

/**
 * Bar numbers in the ruler strip, where they fit.
 *
 * Skipped rather than crowded: at the widest zoom the downbeats of a fast track
 * are twenty pixels apart, and a row of numbers that touch is less readable
 * than no numbers at all. The bars themselves are still drawn — the number is
 * the label, not the line.
 */
function drawBarNumbers(
  ctx: CanvasRenderingContext2D,
  frame: LaneFrame,
  width: number,
  ratio: number,
): void {
  const bars = frame.beats.filter((b) => b.ofBar === 1);
  if (bars.length < 2) return;
  const apart =
    xAtTime(bars[1].secs, frame.window, width) -
    xAtTime(bars[0].secs, frame.window, width);
  if (apart < 34 * ratio) return;
  ctx.fillStyle = frame.colours.ruler;
  ctx.font = `${Math.round(11 * ratio)}px ${font.mono}`;
  ctx.textBaseline = "top";
  for (const bar of bars) {
    const x = xAtTime(bar.secs, frame.window, width);
    if (x < 0 || x > width) continue;
    ctx.fillText(String(bar.bar), x + 3 * ratio, 2 * ratio);
  }
}

/** The moment a device-pixel column stands for. */
function xToTime(x: number, w: LaneWindow, width: number): number {
  return w.from + (x / width) * (w.to - w.from);
}

function clampIndex(i: number, bins: number): number {
  return Math.min(bins - 1, Math.max(0, i));
}
