import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePlayhead } from "./usePlayhead";

/**
 * A frame loop under control: `requestAnimationFrame` is replaced by a queue
 * this test advances by hand, so "one more frame" is a statement rather than a
 * wait. jsdom's own rAF is driven by a timer, which would make every assertion
 * here a race.
 */
let pending: Map<number, FrameRequestCallback>;
let nextHandle: number;
let cancelled: number[];

function advance() {
  const due = [...pending];
  pending = new Map();
  for (const [, cb] of due) cb(performance.now());
}

beforeEach(() => {
  pending = new Map();
  nextHandle = 1;
  cancelled = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    const handle = nextHandle++;
    pending.set(handle, cb);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    cancelled.push(handle);
    pending.delete(handle);
  });
});

afterEach(() => vi.unstubAllGlobals());

function Probe({
  enabled,
  read,
  onFrame,
}: {
  enabled: boolean;
  read: () => number;
  onFrame: (secs: number) => void;
}) {
  usePlayhead(enabled, read, onFrame);
  return null;
}

describe("usePlayhead", () => {
  it("reads the position once a frame while it is running", () => {
    const onFrame = vi.fn();
    let now = 0;
    render(<Probe enabled read={() => (now += 0.5)} onFrame={onFrame} />);

    advance();
    advance();
    expect(onFrame.mock.calls.map(([s]) => s)).toEqual([0.5, 1]);
  });

  it("does not start at all when it is not enabled", () => {
    // The reduced-motion path, and a closed surface: no loop, not a loop whose
    // callback does nothing.
    const onFrame = vi.fn();
    render(<Probe enabled={false} read={() => 1} onFrame={onFrame} />);
    expect(pending.size).toBe(0);
    advance();
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("stops when it is disabled", () => {
    const onFrame = vi.fn();
    const { rerender } = render(
      <Probe enabled read={() => 1} onFrame={onFrame} />,
    );
    advance();
    expect(onFrame).toHaveBeenCalledTimes(1);

    rerender(<Probe enabled={false} read={() => 1} onFrame={onFrame} />);
    advance();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(cancelled.length).toBeGreaterThan(0);
  });

  it("stops on unmount", () => {
    // The one that matters. A frame loop that outlives its component keeps the
    // machine awake for a window that is no longer on screen, and nothing in the
    // app would ever say so.
    const onFrame = vi.fn();
    const { unmount } = render(
      <Probe enabled read={() => 1} onFrame={onFrame} />,
    );
    advance();
    unmount();
    advance();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(pending.size).toBe(0);
    expect(cancelled.length).toBeGreaterThan(0);
  });

  it("keeps running when the callback is a new closure every render", () => {
    // The consumer redraws from state, so `onFrame` is rebuilt on every render.
    // Restarting the loop for that would drop a frame each time, and under a
    // callback that itself causes a render it would never settle.
    const seen: number[] = [];
    const { rerender } = render(
      <Probe enabled read={() => 1} onFrame={(s) => seen.push(s)} />,
    );
    advance();
    const handlesBefore = nextHandle;
    rerender(<Probe enabled read={() => 2} onFrame={(s) => seen.push(s * 10)} />);
    expect(cancelled).toEqual([]);
    advance();
    expect(seen).toEqual([1, 20]);
    // One new frame requested by the loop itself, not a second loop.
    expect(nextHandle - handlesBefore).toBe(1);
  });
});
