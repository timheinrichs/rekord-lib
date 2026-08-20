import { describe, expect, it, vi } from "vitest";
import {
  createPatchCollector,
  waveformPaths,
  PATCH_WINDOW_MS,
} from "./scanPatchBatch";
import type { TrackPatch } from "../types";

function patch(over: Partial<TrackPatch>): TrackPatch {
  return {
    path: "/lib/a.aiff",
    bpm: null,
    bpm_confidence: null,
    key: null,
    key_camelot: null,
    key_confidence: null,
    waveform: false,
    ...over,
  };
}

/** Runs the window by hand, so a test never waits out a real 250 ms. */
function manual() {
  let queued: (() => void) | null = null;
  return {
    schedule: (run: () => void) => {
      queued = run;
      return () => {
        queued = null;
      };
    },
    run: () => {
      const r = queued;
      queued = null;
      r?.();
    },
    pending: () => queued !== null,
  };
}

describe("createPatchCollector", () => {
  it("turns a burst of results into a single list update", () => {
    // The whole point: eight workers finishing inside one window cost one
    // re-render, not eight.
    const apply = vi.fn();
    const q = manual();
    const c = createPatchCollector(apply, PATCH_WINDOW_MS, q.schedule);

    c.add(patch({ path: "/a", bpm: 120 }));
    c.add(patch({ path: "/b", bpm: 121 }));
    c.add(patch({ path: "/c", waveform: true }));
    expect(apply).not.toHaveBeenCalled();

    q.run();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][0]).toHaveLength(3);
  });

  it("opens a new window for what arrives after a flush", () => {
    const apply = vi.fn();
    const q = manual();
    const c = createPatchCollector(apply, PATCH_WINDOW_MS, q.schedule);

    c.add(patch({ path: "/a", bpm: 120 }));
    q.run();
    c.add(patch({ path: "/b", bpm: 121 }));
    q.run();

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls[1][0][0].path).toBe("/b");
  });

  it("folds two results for the same file into one", () => {
    // A forced re-analysis can report the same path twice inside one window;
    // the row should be updated once, with everything both results carried.
    const apply = vi.fn();
    const q = manual();
    const c = createPatchCollector(apply, PATCH_WINDOW_MS, q.schedule);

    c.add(patch({ path: "/a", waveform: true }));
    c.add(patch({ path: "/a", bpm: 128, bpm_confidence: 0.9 }));
    q.run();

    expect(apply.mock.calls[0][0]).toHaveLength(1);
    const merged = apply.mock.calls[0][0][0] as TrackPatch;
    expect(merged.bpm).toBe(128);
    expect(merged.bpm_confidence).toBe(0.9);
    // The waveform came only from the first one and must survive.
    expect(merged.waveform).toBe(true);
  });

  it("keeps the older value where the newer result has none", () => {
    const apply = vi.fn();
    const q = manual();
    const c = createPatchCollector(apply, PATCH_WINDOW_MS, q.schedule);

    c.add(patch({ path: "/a", key: "Am", key_camelot: "8A", key_confidence: 0.6 }));
    c.add(patch({ path: "/a", bpm: 128 }));
    q.run();

    const merged = apply.mock.calls[0][0][0] as TrackPatch;
    expect(merged.key).toBe("Am");
    expect(merged.key_camelot).toBe("8A");
    expect(merged.key_confidence).toBe(0.6);
  });

  it("does nothing when the window closes on an empty collector", () => {
    const apply = vi.fn();
    const q = manual();
    createPatchCollector(apply, PATCH_WINDOW_MS, q.schedule);
    q.run();
    expect(apply).not.toHaveBeenCalled();
  });

  it("hands over what is waiting when asked to flush now", () => {
    const apply = vi.fn();
    const q = manual();
    const c = createPatchCollector(apply, PATCH_WINDOW_MS, q.schedule);

    c.add(patch({ path: "/a", bpm: 120 }));
    c.flush();

    expect(apply).toHaveBeenCalledTimes(1);
    // And the scheduled window was cancelled rather than left to fire again.
    expect(q.pending()).toBe(false);
  });

  it("drops everything on stop, so an unmount cannot be called back into", () => {
    const apply = vi.fn();
    const q = manual();
    const c = createPatchCollector(apply, PATCH_WINDOW_MS, q.schedule);

    c.add(patch({ path: "/a", bpm: 120 }));
    c.stop();
    q.run();

    expect(apply).not.toHaveBeenCalled();
  });
});

describe("waveformPaths", () => {
  it("names only the paths a batch stored a waveform for", () => {
    expect(
      waveformPaths([
        patch({ path: "/a", waveform: true }),
        patch({ path: "/b", bpm: 120 }),
        patch({ path: "/c", waveform: true }),
      ]),
    ).toEqual(["/a", "/c"]);
  });
});
