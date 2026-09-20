import { describe, expect, it } from "vitest";

import { makeMetadata, makeTrack } from "../test/factories";
import {
  driftsFrom,
  effectiveGrid,
  foldAnchor,
  GRID_TEMPO_TOLERANCE,
  MAX_BPM,
  MIN_BPM,
  scaledTempo,
  snapToBeat,
} from "./beatGrid";
import type { GridEdit } from "../types";

const track = () =>
  makeTrack({
    path: "/lib/a.aiff",
    metadata: makeMetadata({ bpm: 128 }),
    beat_offset_secs: 30.25,
  });

const placed = (over: Partial<GridEdit> = {}): GridEdit => ({
  offset_secs: 0.482,
  bpm: 128,
  downbeat: 1,
  edited_ms: 1_700_000_000_000,
  ...over,
});

describe("effectiveGrid", () => {
  it("prefers the grid somebody placed over the one that was detected", () => {
    const grid = effectiveGrid(track(), placed(), 128);
    expect(grid).toEqual({
      anchorSecs: 0.482,
      bpm: 128,
      downbeat: 1,
      source: "hand",
    });
  });

  it("falls back to the detected one, which is always bar position 1", () => {
    // Not because it is, but because the detector does not produce one and the
    // export has asserted it since it started writing `Battito`.
    expect(effectiveGrid(track(), undefined, 128)).toEqual({
      anchorSecs: 30.25,
      bpm: 128,
      downbeat: 1,
      source: "detected",
    });
  });

  it("has no grid where the track has neither half", () => {
    const noPhase = makeTrack({ metadata: makeMetadata({ bpm: 128 }), beat_offset_secs: null });
    expect(effectiveGrid(noPhase, undefined, 128)).toBeNull();
    const noTempo = makeTrack({ metadata: makeMetadata({ bpm: null }), beat_offset_secs: 1 });
    expect(effectiveGrid(noTempo, undefined, null)).toBeNull();
  });

  it("gives a hand-placed anchor the tempo in force, not the one it was stored with", () => {
    // The stored tempo is provenance — what `driftsFrom` answers — and the grid
    // has to be drawn against the period the track actually claims now.
    const grid = effectiveGrid(track(), placed({ bpm: 64 }), 128);
    expect(grid?.bpm).toBe(128);
  });

  it("keeps a hand-placed grid on a track whose tempo has gone", () => {
    // Somebody cleared the BPM tag. The anchor is still theirs, and the stored
    // tempo is the only period left to draw it against.
    const grid = effectiveGrid(track(), placed({ bpm: 128 }), null);
    expect(grid?.bpm).toBe(128);
    expect(grid?.source).toBe("hand");
  });
});

describe("driftsFrom", () => {
  it("forgives a rounding difference and catches an octave", () => {
    expect(driftsFrom(128, 128)).toBe(false);
    expect(driftsFrom(128, 128 * (1 + GRID_TEMPO_TOLERANCE / 2))).toBe(false);
    expect(driftsFrom(128, 256)).toBe(true);
    expect(driftsFrom(128, 64)).toBe(true);
    // 130 typed where the grid was placed at 128 — 1.6 %, which is three beats
    // of drift over a six-minute track.
    expect(driftsFrom(128, 130)).toBe(true);
    // And 127.5 is *not* flagged: 0.4 % is inside the tolerance this shares
    // with the backend's own question about a detected phase. Asserted so the
    // limit is visible rather than implied — it is a tolerance, not a promise
    // that everything below it is inaudible.
    expect(driftsFrom(128, 127.5)).toBe(false);
  });

  it("says nothing about a tempo that is not one", () => {
    expect(driftsFrom(0, 128)).toBe(false);
    expect(driftsFrom(128, 0)).toBe(false);
  });
});

describe("foldAnchor", () => {
  it("puts the anchor on the first beat of the track", () => {
    // 30.25 s at 128 BPM: the period is 0.46875, and 30.25 is 64.53 of them.
    expect(foldAnchor(30.25, 128, 1).offsetSecs).toBeCloseTo(0.25, 9);
  });

  it("carries an anchor dragged past zero back into the first period", () => {
    // `-0.1 % 0.46875` is `-0.1` in JavaScript, and a negative `Inizio` is not
    // a position in a track.
    const folded = foldAnchor(-0.1, 128, 1);
    expect(folded.offsetSecs).toBeGreaterThan(0);
    expect(folded.offsetSecs).toBeCloseTo(0.36875, 9);
  });

  it("keeps the beat somebody designated on the beat they said it was", () => {
    // The bug this function exists to not have. Bar positions are counted from
    // the anchor, so folding it back k beats rotates every bar line unless k is
    // a multiple of four — and the picture stays evenly spaced either way.
    const bpm = 125;
    const clicked = 30.25;
    const period = 60 / bpm;
    for (const said of [1, 2, 3, 4]) {
      const folded = foldAnchor(clicked, bpm, said);
      // Where the clicked beat now sits in the count from the stored anchor.
      const n = Math.round((clicked - folded.offsetSecs) / period);
      const reads = (((folded.downbeat - 1 + n) % 4) + 4) % 4 + 1;
      expect(reads).toBe(said);
    }
  });

  it("keeps it when a nudge wraps the anchor around zero", () => {
    // A 5 ms nudge on an anchor at 2 ms: the easiest way to hit the same bug,
    // and the one where a whole bar moving would be most obviously wrong.
    const bpm = 128;
    const period = 60 / bpm;
    const folded = foldAnchor(0.002 - 0.005, bpm, 3);
    expect(folded.offsetSecs).toBeCloseTo(period - 0.003, 9);
    // One beat *earlier* in the count, so the designated beat is one later.
    expect(folded.downbeat).toBe(4);
  });

  it("answers rather than dividing by zero", () => {
    expect(foldAnchor(1, 0, 2)).toEqual({ offsetSecs: 0, downbeat: 2 });
    expect(foldAnchor(NaN, 128, 2)).toEqual({ offsetSecs: 0, downbeat: 2 });
  });
});

describe("scaledTempo", () => {
  it("halves and doubles to two decimals", () => {
    expect(scaledTempo(128, 0.5)).toBe(64);
    expect(scaledTempo(128, 2)).toBe(256);
    expect(scaledTempo(127.55, 2)).toBe(255.1);
  });

  it("refuses a result the app would not store", () => {
    // The button says the number it would produce, so a number outside the
    // range has to disable it rather than write something unusable.
    expect(scaledTempo(MIN_BPM + 1, 0.5)).toBeNull();
    expect(scaledTempo(MAX_BPM - 1, 2)).toBeNull();
  });
});

describe("snapToBeat", () => {
  const grid = { anchorSecs: 0.25, bpm: 128, downbeat: 1 };

  it("lands on the beat when the click was near one", () => {
    expect(snapToBeat(0.26, grid)).toBeCloseTo(0.25, 9);
    expect(snapToBeat(0.72, grid)).toBeCloseTo(0.71875, 9);
  });

  it("leaves a click that was nowhere near one alone", () => {
    // Half a beat away at 128 BPM is 234 ms, far outside the tolerance.
    expect(snapToBeat(0.48, grid)).toBe(0.48);
  });

  it("never snaps to a beat before the track starts", () => {
    expect(snapToBeat(0.01, grid)).toBe(0.01);
  });

  it("does nothing without a grid", () => {
    expect(snapToBeat(1.234, null)).toBe(1.234);
  });
});
