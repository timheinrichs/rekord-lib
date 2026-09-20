import type { GridEdit, TrackAnalysis } from "../types";
import type { Grid } from "./gridLane";

/**
 * Resolving what a track's beat grid actually is, and the arithmetic of moving
 * it.
 *
 * Pure, and separate from the surface that draws it, for the reason
 * `gridLane.ts` gives about its own maths: a grid one beat out looks exactly
 * like a grid on time. Everything here is a number that can be asserted.
 */

/**
 * How far a tempo may sit from the one an anchor was placed against before the
 * grid it belongs to drifts visibly.
 *
 * The twin of `GRID_TEMPO_TOLERANCE` in `commands.rs`, which asks the same
 * question of the *detected* grid: does this phase still belong to that period?
 * 0.5 % is well inside one decimal place at any club tempo and well outside a
 * half- or double-time disagreement. Mirrored rather than shared because one
 * side is Rust and the other is the screen; the cases are tested in both.
 */
export const GRID_TEMPO_TOLERANCE = 0.005;

/** The narrowest and widest tempo a halve or a double may land on. */
export const MIN_BPM = 30;
export const MAX_BPM = 300;

/** Where a grid came from, which is what "reset to detected" needs to know. */
export type GridSource = "hand" | "detected";

export interface EffectiveGrid extends Grid {
  source: GridSource;
}

/**
 * The grid a track actually has: the hand-placed one where there is one, the
 * detected one otherwise, and `null` where there is neither.
 *
 * The overlay resolved once, in one place, so the drawing, the export and the
 * controls cannot disagree about which grid is in force — the same shape
 * `export::rekordbox` uses on the Rust side for the same reason.
 *
 * A detected grid is always `downbeat: 1`, because that is what the app has
 * asserted since it started writing `Battito` and the bar position is precisely
 * what the detector does not produce.
 */
export function effectiveGrid(
  track: TrackAnalysis,
  edit: GridEdit | undefined,
  bpm: number | null | undefined,
): EffectiveGrid | null {
  if (edit) {
    return {
      anchorSecs: edit.offset_secs,
      // The tempo in force, not the one the anchor was stored with: that one is
      // provenance, and `driftsFrom` below is what it answers.
      bpm: bpm && bpm > 0 ? bpm : edit.bpm,
      downbeat: edit.downbeat,
      source: "hand",
    };
  }
  if (track.beat_offset_secs == null || !bpm || bpm <= 0) return null;
  return {
    anchorSecs: track.beat_offset_secs,
    bpm,
    downbeat: 1,
    source: "detected",
  };
}

/**
 * Whether a grid's phase still belongs to the tempo now in force.
 *
 * A phase is measured against a period. Change the period and the beats walk
 * away from the audio — slowly enough that the first bar still looks right,
 * which is exactly why this is worth saying out loud rather than drawing.
 */
export function driftsFrom(measuredAgainst: number, bpm: number): boolean {
  if (!(measuredAgainst > 0) || !(bpm > 0)) return false;
  return Math.abs(bpm - measuredAgainst) / measuredAgainst > GRID_TEMPO_TOLERANCE;
}

/**
 * Folds an anchor into the first period of the track — **and rotates the bar
 * position with it**.
 *
 * Every beat of a grid is the same grid, so the anchor may as well be the first
 * one: it keeps the stored number small and comparable, and it is what the
 * detector's own normalisation does (`beats.rs`). Euclidean, because a drag or
 * a nudge can carry the anchor past zero and `-0.1 % 0.5` is `-0.1` here.
 *
 * The rotation is the part that is easy to leave out, and leaving it out is a
 * bug you cannot see. `beatsInWindow` counts bar positions *from the anchor*,
 * so moving the anchor back k beats moves every bar line unless k is a multiple
 * of four. Somebody clicks "this beat is 3" at 30.25 s on a 125 BPM track, the
 * fold takes k = 63 beats off, and the beat they clicked is drawn — and
 * exported as `Battito` — as beat 2. The lines are still evenly spaced and
 * still land on the music, which is exactly why nobody would notice.
 */
export function foldAnchor(
  anchorSecs: number,
  bpm: number,
  downbeat: number,
): { offsetSecs: number; downbeat: number } {
  if (!(bpm > 0) || !Number.isFinite(anchorSecs)) {
    return { offsetSecs: 0, downbeat };
  }
  const period = 60 / bpm;
  const beats = Math.floor(anchorSecs / period);
  return {
    offsetSecs: anchorSecs - beats * period,
    // The beat that *was* `downbeat` has to still read `downbeat` once it is
    // `beats` further along the count.
    downbeat: mod(downbeat - 1 - beats, 4) + 1,
  };
}

/** Euclidean remainder: `-1 % 4` is `-1` in JavaScript and `3` here. */
function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * The tempo halved or doubled, or `null` where the result leaves the range the
 * app will store.
 *
 * Offered because the one tempo error a detector makes systematically is the
 * octave, and it is the one a listener spots instantly. Labelled with the
 * *result* in the UI rather than with the operator: what you are choosing is
 * 64 or 256, not an arithmetic.
 */
export function scaledTempo(bpm: number, factor: 0.5 | 2): number | null {
  const next = bpm * factor;
  if (!Number.isFinite(next) || next < MIN_BPM || next > MAX_BPM) return null;
  // Two decimals, which is what the export writes and therefore all the
  // precision a stored tempo can carry.
  return Math.round(next * 100) / 100;
}

/**
 * The beat nearest `secs`, when it is near enough to have been meant.
 *
 * Used while seeking, so a click lands on a beat and you hear the downbeat
 * rather than the tail of the one before it. Deliberately **not** used by "set
 * the anchor to the playhead": snapping the playhead to the grid and then
 * setting the grid from the playhead is a loop that moves nothing, and it is
 * the bug in the first version of every grid editor.
 */
export function snapToBeat(
  secs: number,
  grid: Grid | null,
  toleranceSecs = 0.04,
): number {
  if (!grid || !(grid.bpm > 0)) return secs;
  const period = 60 / grid.bpm;
  const nearest = grid.anchorSecs + Math.round((secs - grid.anchorSecs) / period) * period;
  return Math.abs(nearest - secs) <= toleranceSecs && nearest >= 0 ? nearest : secs;
}

