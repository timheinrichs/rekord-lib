import { describe, expect, it, vi } from "vitest";
import { createWaveformCache } from "./waveformCache";
import type { Waveform } from "../types";

const wf = (n: number): Waveform => ({ peak: [n], rms: [n] });

describe("createWaveformCache", () => {
  it("computes once and serves the same result afterwards", async () => {
    const compute = vi.fn(async () => wf(1));
    const cache = createWaveformCache();

    expect(await cache.get("/a.aiff", compute)).toEqual(wf(1));
    expect(await cache.get("/a.aiff", compute)).toEqual(wf(1));
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("shares an in-flight decode instead of starting a second one", async () => {
    // The case that matters: skipping between two tracks fires the request again
    // before the first has resolved, and a full-track decode is expensive.
    let resolve: (w: Waveform) => void = () => {};
    const compute = vi.fn(() => new Promise<Waveform>((r) => (resolve = r)));
    const cache = createWaveformCache();

    const first = cache.get("/a.aiff", compute);
    const second = cache.get("/a.aiff", compute);
    expect(compute).toHaveBeenCalledTimes(1);

    resolve(wf(2));
    expect(await first).toEqual(wf(2));
    expect(await second).toEqual(wf(2));
  });

  it("does not remember a failure", async () => {
    // A decode can fail because the file was momentarily busy. Caching that
    // would leave the track without a waveform for the rest of the session.
    const compute = vi
      .fn<() => Promise<Waveform>>()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(wf(3));
    const cache = createWaveformCache();

    await expect(cache.get("/a.aiff", compute)).rejects.toThrow("busy");
    expect(cache.size()).toBe(0);
    expect(await cache.get("/a.aiff", compute)).toEqual(wf(3));
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used entry", async () => {
    const compute = vi.fn(async (p: string) => wf(p.length));
    const cache = createWaveformCache(2);

    await cache.get("/a.aiff", compute);
    await cache.get("/b.aiff", compute);
    // Touching /a makes /b the oldest.
    await cache.get("/a.aiff", compute);
    await cache.get("/c.aiff", compute);

    expect(cache.size()).toBe(2);
    compute.mockClear();
    await cache.get("/a.aiff", compute);
    expect(compute).not.toHaveBeenCalled();
    await cache.get("/b.aiff", compute);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("forgets on request", async () => {
    const compute = vi.fn(async () => wf(1));
    const cache = createWaveformCache();

    await cache.get("/a.aiff", compute);
    cache.forget("/a.aiff");
    await cache.get("/a.aiff", compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });
});
