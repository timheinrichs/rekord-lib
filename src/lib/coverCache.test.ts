import { describe, expect, it, vi } from "vitest";
import { createCoverCache } from "./coverCache";

/** A fetch whose answers are handed out one at a time, so races are testable. */
function deferredFetch() {
  const calls: { path: string; resolve: (url: string | null) => void; reject: (e: unknown) => void }[] =
    [];
  const fetch = vi.fn(
    (path: string) =>
      new Promise<string | null>((resolve, reject) => {
        calls.push({ path, resolve, reject });
      }),
  );
  return { fetch, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createCoverCache", () => {
  it("asks once and remembers the answer", async () => {
    const { fetch, calls } = deferredFetch();
    const cache = createCoverCache(fetch);
    const seen = vi.fn();

    cache.request("/a.aiff", seen);
    expect(cache.get("/a.aiff")).toBeUndefined();
    calls[0].resolve("data:image/jpeg;base64,AAA");
    await flush();

    expect(cache.get("/a.aiff")).toBe("data:image/jpeg;base64,AAA");
    expect(seen).toHaveBeenCalled();

    // A second row asking is served from memory.
    cache.request("/a.aiff", vi.fn());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks once for two rows wanting the same file", async () => {
    const { fetch, calls } = deferredFetch();
    const cache = createCoverCache(fetch);
    const first = vi.fn();
    const second = vi.fn();

    cache.request("/a.aiff", first);
    cache.request("/a.aiff", second);
    expect(fetch).toHaveBeenCalledTimes(1);

    calls[0].resolve("url");
    await flush();
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });

  it("remembers that a track has no cover, and stops asking", async () => {
    const { fetch, calls } = deferredFetch();
    const cache = createCoverCache(fetch);

    cache.request("/none.aiff", vi.fn());
    calls[0].resolve(null);
    await flush();

    expect(cache.get("/none.aiff")).toBeNull();
    cache.request("/none.aiff", vi.fn());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not remember a failed read as 'no cover'", async () => {
    const { fetch, calls } = deferredFetch();
    const cache = createCoverCache(fetch);

    cache.request("/a.aiff", vi.fn());
    calls[0].reject(new Error("unreadable"));
    await flush();

    // Nothing learned, so the next row that scrolls past tries again rather
    // than being left with a permanent blank.
    expect(cache.get("/a.aiff")).toBeUndefined();
    cache.request("/a.aiff", vi.fn());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("gives up on a file whose cover keeps failing to load", async () => {
    // The table is virtualised, so a row that fails scrolls away and comes back
    // asking again. A backend that could not decode this artwork once will not
    // manage it on the next pass either.
    const { fetch, calls } = deferredFetch();
    const cache = createCoverCache(fetch);

    cache.request("/bad.aiff", vi.fn());
    calls[0].reject(new Error("decode failed"));
    await flush();
    expect(cache.get("/bad.aiff")).toBeUndefined();

    cache.request("/bad.aiff", vi.fn());
    calls[1].reject(new Error("decode failed"));
    await flush();

    // Remembered as coverless now, so scrolling past it again costs nothing.
    expect(cache.get("/bad.aiff")).toBeNull();
    cache.request("/bad.aiff", vi.fn());
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("tries again after a write, even for a file that had been failing", async () => {
    const { fetch, calls } = deferredFetch();
    const cache = createCoverCache(fetch);
    cache.request("/bad.aiff", vi.fn());
    calls[0].reject(new Error("x"));
    await flush();
    cache.request("/bad.aiff", vi.fn());
    calls[1].reject(new Error("x"));
    await flush();
    expect(cache.get("/bad.aiff")).toBeNull();

    // A write is the one thing that could change the answer.
    cache.forget(["/bad.aiff"]);
    cache.request("/bad.aiff", vi.fn());
    expect(fetch).toHaveBeenCalledTimes(3);
    calls[2].resolve("now it works");
    await flush();
    expect(cache.get("/bad.aiff")).toBe("now it works");
  });

  it("re-asks for a forgotten path a row is still showing", async () => {
    // The whole point of C7: a mounted row asked once and will not ask again on
    // its own, so dropping the entry alone leaves the stale image on screen.
    const { fetch, calls } = deferredFetch();
    const cache = createCoverCache(fetch);
    const seen = vi.fn();

    cache.request("/a.aiff", seen);
    calls[0].resolve("old");
    await flush();
    expect(cache.get("/a.aiff")).toBe("old");

    cache.forget(["/a.aiff"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    calls[1].resolve("new");
    await flush();

    expect(cache.get("/a.aiff")).toBe("new");
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it("only drops a forgotten path nobody is showing", async () => {
    const { fetch, calls } = deferredFetch();
    const cache = createCoverCache(fetch);

    const unsubscribe = cache.request("/a.aiff", vi.fn());
    calls[0].resolve("old");
    await flush();
    unsubscribe();

    cache.forget(["/a.aiff"]);
    // No round trip for a row that is not on screen — the next one to scroll
    // past will fetch it.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.get("/a.aiff")).toBeUndefined();
  });

  it("ignores an answer that was already in flight when the file changed", async () => {
    // The read describes the file as it was before the write. Letting it land
    // would put the old thumbnail back by a longer route.
    const { fetch, calls } = deferredFetch();
    const cache = createCoverCache(fetch);
    cache.request("/a.aiff", vi.fn());

    cache.forget(["/a.aiff"]);
    expect(fetch).toHaveBeenCalledTimes(2);

    calls[1].resolve("new");
    calls[0].resolve("stale");
    await flush();

    expect(cache.get("/a.aiff")).toBe("new");
  });

  it("stops calling a row that has gone away", async () => {
    const { fetch, calls } = deferredFetch();
    const cache = createCoverCache(fetch);
    const gone = vi.fn();

    const unsubscribe = cache.request("/a.aiff", gone);
    unsubscribe();
    calls[0].resolve("url");
    await flush();

    expect(gone).not.toHaveBeenCalled();
    // The answer is still kept — it was paid for.
    expect(cache.get("/a.aiff")).toBe("url");
  });
});
