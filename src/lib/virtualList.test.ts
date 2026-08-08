import { describe, expect, it } from "vitest";
import {
  ESTIMATED_ROW_HEIGHT,
  indexAtOffset,
  prefixSums,
  resizeHeights,
  visibleRange,
} from "./virtualList";

/** 10 rows of 64 px, except rows 3 and 4 which wrap to 70 px. */
const HEIGHTS = [64, 64, 64, 70, 70, 64, 64, 64, 64, 64];

describe("prefixSums", () => {
  it("returns running offsets with the total at the end", () => {
    expect(prefixSums([10, 20, 30])).toEqual([0, 10, 30, 60]);
  });

  it("handles an empty list", () => {
    expect(prefixSums([])).toEqual([0]);
  });
});

describe("indexAtOffset", () => {
  const prefix = prefixSums(HEIGHTS);

  it("finds the row containing an offset", () => {
    expect(indexAtOffset(prefix, 0)).toBe(0);
    expect(indexAtOffset(prefix, 63)).toBe(0);
    expect(indexAtOffset(prefix, 64)).toBe(1);
    expect(indexAtOffset(prefix, 200)).toBe(3); // 192..262 is row 3
  });

  it("clamps outside the list", () => {
    expect(indexAtOffset(prefix, -500)).toBe(0);
    expect(indexAtOffset(prefix, 999_999)).toBe(HEIGHTS.length - 1);
  });

  it("survives an empty list", () => {
    expect(indexAtOffset(prefixSums([]), 42)).toBe(0);
  });
});

describe("visibleRange", () => {
  it("renders only the window plus overscan", () => {
    // Viewport shows rows 0..2; with an overscan of 1 that is rows 0..3.
    const r = visibleRange(HEIGHTS, 0, 180, 1);
    expect(r.start).toBe(0);
    expect(r.end).toBe(4);
    expect(r.paddingTop).toBe(0);
  });

  it("moves the window as the list scrolls past the fold", () => {
    // listTop = -300 means 300 px of the list are above the viewport.
    const r = visibleRange(HEIGHTS, -300, 180, 1);
    expect(r.start).toBeGreaterThan(0);
    expect(r.end).toBeGreaterThan(r.start);
    // The leading spacer must equal the summed height of the skipped rows.
    expect(r.paddingTop).toBe(prefixSums(HEIGHTS)[r.start]);
  });

  it("keeps the spacers consistent with the total height", () => {
    const total = prefixSums(HEIGHTS)[HEIGHTS.length];
    for (const top of [0, -100, -300, -600, -5000]) {
      const r = visibleRange(HEIGHTS, top, 200, 2);
      const rendered = prefixSums(HEIGHTS)[r.end] - prefixSums(HEIGHTS)[r.start];
      expect(r.paddingTop + rendered + r.paddingBottom).toBe(total);
    }
  });

  it("renders nothing for an empty list", () => {
    expect(visibleRange([], 0, 800)).toEqual({
      start: 0,
      end: 0,
      paddingTop: 0,
      paddingBottom: 0,
    });
  });

  it("accounts for the taller wrapped rows rather than assuming a fixed height", () => {
    // Rows 3 and 4 are 6 px taller each; a fixed-height calculation would place
    // the window 12 px too high by the end of the list.
    const r = visibleRange(HEIGHTS, -600, 100, 0);
    expect(r.paddingTop).toBe(prefixSums(HEIGHTS)[r.start]);
    expect(r.start).toBe(indexAtOffset(prefixSums(HEIGHTS), 600));
  });

  it("still renders the last rows when scrolled to the very bottom", () => {
    const total = prefixSums(HEIGHTS)[HEIGHTS.length];
    const r = visibleRange(HEIGHTS, -total, 200, 1);
    expect(r.end).toBe(HEIGHTS.length);
    expect(r.paddingBottom).toBe(0);
  });
});

describe("resizeHeights", () => {
  it("keeps known heights and fills the rest with the estimate", () => {
    expect(resizeHeights([70, 70], 4)).toEqual([
      70,
      70,
      ESTIMATED_ROW_HEIGHT,
      ESTIMATED_ROW_HEIGHT,
    ]);
  });

  it("truncates when the list shrinks", () => {
    expect(resizeHeights([70, 71, 72], 2)).toEqual([70, 71]);
  });

  it("is reference-stable when the length already matches", () => {
    const before = [64, 64];
    expect(resizeHeights(before, 2)).toBe(before);
  });
});
