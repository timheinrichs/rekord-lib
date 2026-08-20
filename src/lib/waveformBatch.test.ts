import { describe, expect, it, vi } from "vitest";
import { createWaveformBatcher } from "./waveformBatch";
import type { Waveform } from "../types";

const wf = (n: number): Waveform => ({ peak: [n], rms: [n] });

/** Runs the queued flush by hand, so a test never waits on a real microtask. */
function manual() {
  const queue: (() => void)[] = [];
  return {
    schedule: (run: () => void) => queue.push(run),
    run: () => queue.splice(0).forEach((r) => r()),
  };
}

describe("createWaveformBatcher", () => {
  it("asks once for everything a screenful of rows wants", async () => {
    // The whole point: twenty visible rows are one call, not twenty.
    const fetch = vi.fn(async (paths: string[]) =>
      Object.fromEntries(paths.map((p, i) => [p, wf(i)])),
    );
    const q = manual();
    const b = createWaveformBatcher(fetch, q.schedule);

    b.request("/a", () => {});
    b.request("/b", () => {});
    b.request("/c", () => {});
    q.run();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toEqual(["/a", "/b", "/c"]);
  });

  it("tells the rows when their answer is in", async () => {
    const fetch = vi.fn(async () => ({ "/a": wf(1) }));
    const q = manual();
    const b = createWaveformBatcher(fetch, q.schedule);
    const loaded = vi.fn();

    b.request("/a", loaded);
    q.run();
    await vi.waitFor(() => expect(loaded).toHaveBeenCalled());
    expect(b.get("/a")).toEqual(wf(1));
  });

  it("does not ask twice for something it already knows", async () => {
    const fetch = vi.fn(async () => ({ "/a": wf(1) }));
    const q = manual();
    const b = createWaveformBatcher(fetch, q.schedule);

    b.request("/a", () => {});
    q.run();
    await vi.waitFor(() => expect(b.get("/a")).toBeDefined());

    fetch.mockClear();
    b.request("/a", () => {});
    q.run();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("remembers that a track has no waveform yet", async () => {
    // A track the scan has not reached must not be re-requested on every
    // scroll past it.
    const fetch = vi.fn(async () => ({}));
    const q = manual();
    const b = createWaveformBatcher(fetch, q.schedule);

    b.request("/a", () => {});
    q.run();
    await vi.waitFor(() => expect(b.get("/a")).toBeNull());

    fetch.mockClear();
    b.request("/a", () => {});
    q.run();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries after a failure instead of blanking the row for good", async () => {
    const fetch = vi
      .fn<(paths: string[]) => Promise<Record<string, Waveform>>>()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce({ "/a": wf(2) });
    const q = manual();
    const b = createWaveformBatcher(fetch, q.schedule);
    const loaded = vi.fn();

    b.request("/a", loaded);
    q.run();
    await vi.waitFor(() => expect(loaded).toHaveBeenCalled());
    // Nothing was learned, so the path is still unknown rather than absent.
    expect(b.get("/a")).toBeUndefined();

    b.request("/a", () => {});
    q.run();
    await vi.waitFor(() => expect(b.get("/a")).toEqual(wf(2)));
  });

  it("stops calling a row that has scrolled away", async () => {
    const fetch = vi.fn(async () => ({ "/a": wf(1) }));
    const q = manual();
    const b = createWaveformBatcher(fetch, q.schedule);
    const gone = vi.fn();

    const unsubscribe = b.request("/a", gone);
    unsubscribe();
    q.run();
    await vi.waitFor(() => expect(b.get("/a")).toBeDefined());
    expect(gone).not.toHaveBeenCalled();
  });

  it("re-asks for the rows on screen when a scan finishes", async () => {
    // The bug this exists for: a row visible during the scan was told there is
    // no waveform, and clearing the cache alone never reached it — it asks once,
    // on mount. Waveforms then showed up only under a group expanded *after*
    // the scan, because those rows were mounting for the first time.
    const fetch = vi
      .fn<(paths: string[]) => Promise<Record<string, Waveform>>>()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ "/a": wf(5) });
    const q = manual();
    const b = createWaveformBatcher(fetch, q.schedule);
    const loaded = vi.fn();

    b.request("/a", loaded);
    q.run();
    await vi.waitFor(() => expect(b.get("/a")).toBeNull());
    loaded.mockClear();

    b.forget();
    q.run();
    await vi.waitFor(() => expect(b.get("/a")).toEqual(wf(5)));
    // And the row was told, so it redraws without remounting.
    expect(loaded).toHaveBeenCalled();
  });

  it("has nothing to re-ask when no row is listening", async () => {
    const fetch = vi.fn(async () => ({}));
    const q = manual();
    const b = createWaveformBatcher(fetch, q.schedule);

    const stop = b.request("/a", () => {});
    q.run();
    await vi.waitFor(() => expect(b.get("/a")).toBeNull());
    stop();

    fetch.mockClear();
    b.forget();
    q.run();
    expect(fetch).not.toHaveBeenCalled();
  });
});
