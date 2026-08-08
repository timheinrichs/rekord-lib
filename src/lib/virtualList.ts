/**
 * Windowing maths for a long list that scrolls with the page.
 *
 * Row heights are not uniform — a track whose status column wraps to two badge
 * lines is taller than one with none — so positions come from measured heights
 * via a prefix sum rather than from `index * rowHeight`.
 */

/** Rows rendered beyond the viewport on each side, to hide scroll latency. */
export const OVERSCAN = 8;

/** Height assumed for a row that has not been measured yet (px). */
export const ESTIMATED_ROW_HEIGHT = 64;

export interface Range {
  /** First index to render (inclusive). */
  start: number;
  /** Last index to render (exclusive). */
  end: number;
  /** Total height of the rows before `start`, for the leading spacer. */
  paddingTop: number;
  /** Total height of the rows from `end` on, for the trailing spacer. */
  paddingBottom: number;
}

/**
 * Running offsets of every row: `prefix[i]` is the distance from the top of the
 * list to row `i`, and `prefix[n]` is the total height. Length is `n + 1`.
 */
export function prefixSums(heights: readonly number[]): number[] {
  const out = new Array<number>(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i++) {
    out[i + 1] = out[i] + heights[i];
  }
  return out;
}

/** Index of the last row that starts at or before `offset` (binary search). */
export function indexAtOffset(prefix: readonly number[], offset: number): number {
  const last = prefix.length - 2; // highest valid row index
  if (last < 0) return 0;
  if (offset <= 0) return 0;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (prefix[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Which rows to render, given how far the list's top sits above the viewport.
 *
 * `listTop` is the list's position relative to the viewport, i.e. what
 * `getBoundingClientRect().top` returns: positive while the list is still below
 * the fold, negative once it has scrolled past. Taking it straight from the
 * rect means no separate bookkeeping of page scroll or element offset.
 */
export function visibleRange(
  heights: readonly number[],
  listTop: number,
  viewportHeight: number,
  overscan: number = OVERSCAN,
): Range {
  const count = heights.length;
  if (count === 0) {
    return { start: 0, end: 0, paddingTop: 0, paddingBottom: 0 };
  }
  const prefix = prefixSums(heights);

  // Portion of the list covered by the viewport, in list coordinates.
  const from = -listTop;
  const to = from + viewportHeight;

  const start = Math.max(0, indexAtOffset(prefix, from) - overscan);
  const end = Math.min(count, indexAtOffset(prefix, to) + 1 + overscan);

  return {
    start,
    end,
    paddingTop: prefix[start],
    paddingBottom: prefix[count] - prefix[end],
  };
}

/**
 * Grows or shrinks the height table to `count` entries, keeping what is already
 * known and filling the rest with the estimate. Returns the same array when
 * nothing changes, so it can be used directly as React state.
 */
export function resizeHeights(
  heights: readonly number[],
  count: number,
  estimate: number = ESTIMATED_ROW_HEIGHT,
): number[] {
  if (heights.length === count) return heights as number[];
  const out = new Array<number>(count);
  for (let i = 0; i < count; i++) {
    out[i] = i < heights.length ? heights[i] : estimate;
  }
  return out;
}
