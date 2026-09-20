import { describe, expect, it } from "vitest";

import {
  beatsInWindow,
  DEFAULT_ZOOM_SPAN,
  laneWindow,
  nearestSpan,
  pagedWindow,
  timeAtX,
  xAtTime,
  ZOOM_SPANS,
  type Grid,
} from "./gridLane";

/** 128 BPM, anchored where the detector usually puts one: inside the track. */
const grid: Grid = { anchorSecs: 30, bpm: 128, downbeat: 1 };

describe("laneWindow", () => {
  it("keeps the playhead in the middle", () => {
    expect(laneWindow(60, 16)).toEqual({ from: 52, to: 68 });
  });

  it("keeps it there at the start of the track too", () => {
    // Clamping the window into the track would put the playhead off-centre for
    // the first half-span, and a cursor that is only sometimes in the middle is
    // one you have to look for. The margin runs past zero instead.
    expect(laneWindow(1, 16)).toEqual({ from: -7, to: 9 });
  });
});

describe("pagedWindow", () => {
  it("stands still until the playhead leaves it", () => {
    expect(pagedWindow(0, 8)).toEqual({ from: 0, to: 8 });
    expect(pagedWindow(7.9, 8)).toEqual({ from: 0, to: 8 });
    expect(pagedWindow(8.1, 8)).toEqual({ from: 8, to: 16 });
  });

  it("starts at the start rather than before it", () => {
    // The scrolling window may run past zero; a page may not, or the first page
    // of every track would be half empty for no reason.
    expect(pagedWindow(-1, 8).from).toBe(0);
  });
});

describe("xAtTime and timeAtX", () => {
  const w = { from: 52, to: 68 };

  it("puts the middle of the window in the middle of the lane", () => {
    expect(xAtTime(60, w, 800)).toBe(400);
  });

  it("round-trips a sub-pixel position", () => {
    // A drag reads a pixel and writes a time, and the readout shows three
    // decimals; a millisecond lost in the conversion would be a millisecond the
    // user cannot put back.
    for (const x of [0, 1, 399.5, 400, 799]) {
      expect(timeAtX(x, w, 800)).toBeCloseTo(52 + (x / 800) * 16, 12);
      expect(xAtTime(timeAtX(x, w, 800), w, 800)).toBeCloseTo(x, 9);
    }
  });

  it("answers rather than dividing by zero on a lane with no width", () => {
    // The first render, before the element has been measured.
    expect(timeAtX(10, w, 0)).toBe(52);
    expect(xAtTime(60, { from: 5, to: 5 }, 800)).toBe(0);
  });
});

describe("beatsInWindow", () => {
  it("spaces the beats by the tempo", () => {
    const beats = beatsInWindow({ from: 30, to: 32 }, grid, 300);
    // 128 BPM is 0.46875 s a beat.
    expect(beats.map((b) => b.secs)).toEqual([
      30, 30.46875, 30.9375, 31.40625, 31.875,
    ]);
  });

  it("counts backwards from the anchor as well as forwards", () => {
    // The detector anchors at 0:30 by construction, so every beat of the intro
    // is *before* the stored phase. A grid that started at the anchor would
    // leave the first half-minute of every track undrawn.
    const beats = beatsInWindow({ from: 0, to: 1 }, grid, 300);
    expect(beats.length).toBeGreaterThan(0);
    for (const b of beats) expect(b.secs).toBeLessThan(30);
    // 30 s is exactly 64 beats at 128 BPM, so this grid's phase puts one on
    // zero; the first beat in the window is the first beat of the track.
    expect(beats[0].secs).toBeCloseTo(0, 9);
    // A phase that does not divide evenly still starts inside the first beat.
    const offbeat = beatsInWindow({ from: 0, to: 1 }, { ...grid, anchorSecs: 30.1 }, 300);
    expect(offbeat[0].secs).toBeCloseTo(0.1, 9);
  });

  it("numbers the bars from the start of the track, not from the anchor", () => {
    // The detector anchors 30 s in on every track over 40 s, so numbering from
    // the anchor would label the whole intro `0, -1, -2 …` and put bar 1 half a
    // minute into the file.
    const first = beatsInWindow({ from: 0, to: 1.9 }, grid, 300);
    expect(first[0].bar).toBe(1);
    expect(first.map((b) => b.bar)).toEqual([1, 1, 1, 1, 2]);
    // 30 s at 128 BPM is 64 beats, i.e. sixteen whole bars, so the anchor opens
    // bar 17.
    const atAnchor = beatsInWindow({ from: 30, to: 31.9 }, grid, 300);
    expect(atAnchor.map((b) => b.ofBar)).toEqual([1, 2, 3, 4, 1]);
    expect(atAnchor.map((b) => b.bar)).toEqual([17, 17, 17, 17, 18]);
  });

  it("gives the track's first, partial bar the number 1", () => {
    // A grid whose beats do not divide the start evenly: the first bar on
    // screen is incomplete, and it is still bar 1 rather than bar 0.
    const off = { ...grid, anchorSecs: 30.2 };
    const beats = beatsInWindow({ from: 0, to: 2 }, off, 300);
    expect(Math.min(...beats.map((b) => b.bar))).toBe(1);
  });

  it("puts the anchor on the beat of the bar it says it is", () => {
    // The whole point of the stored downbeat: `Battito="3"` means the anchor is
    // beat three, so the bar started two beats earlier.
    const third = beatsInWindow({ from: 30, to: 31.9 }, { ...grid, downbeat: 3 }, 300);
    expect(third.map((b) => b.ofBar)).toEqual([3, 4, 1, 2, 3]);
  });

  it("wraps the bar position backwards without a negative remainder", () => {
    // `-1 % 4` is `-1` in JavaScript. A beat one before a downbeat is beat 4.
    const before = beatsInWindow({ from: 29.5, to: 30.05 }, grid, 300);
    expect(before[before.length - 1].ofBar).toBe(1);
    expect(before[before.length - 2].ofBar).toBe(4);
  });

  it("stops where the audio does", () => {
    // A line past the end says there is a beat there.
    const beats = beatsInWindow({ from: 99, to: 110 }, grid, 100);
    expect(beats.every((b) => b.secs <= 100)).toBe(true);
    expect(beatsInWindow({ from: 101, to: 110 }, grid, 100)).toEqual([]);
  });

  it("draws nothing for a tempo that is not one", () => {
    for (const bpm of [0, -1, NaN, Infinity]) {
      expect(beatsInWindow({ from: 0, to: 10 }, { ...grid, bpm }, 300)).toEqual([]);
    }
  });
});

describe("the zoom ladder", () => {
  it("offers spans in seconds, widest first", () => {
    expect([...ZOOM_SPANS]).toEqual([32, 16, 8, 4, 2]);
    expect(ZOOM_SPANS).toContain(DEFAULT_ZOOM_SPAN);
  });

  it("finds its way back from a stored span that is no longer offered", () => {
    // The default zoom is persisted, and the ladder may change under it.
    expect(nearestSpan(15)).toBe(16);
    expect(nearestSpan(1)).toBe(2);
    expect(nearestSpan(1000)).toBe(32);
  });
});
