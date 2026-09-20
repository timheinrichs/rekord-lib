import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampIndex,
  LOAD_COALESCE_MS,
  PlayerProvider,
  subtitleParts,
  usePlayer,
  type PlayerTrack,
} from "./player";

// The asset URL needs Tauri's internals, which a unit test has no business
// standing up: the path it produces is not what is under test here.
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

describe("clampIndex", () => {
  it("keeps an index within bounds", () => {
    expect(clampIndex(2, 5)).toBe(2);
    expect(clampIndex(-1, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
  });

  it("returns 0 for an empty queue", () => {
    expect(clampIndex(3, 0)).toBe(0);
    expect(clampIndex(0, 0)).toBe(0);
  });
});

describe("subtitleParts", () => {
  const track = (over: Partial<PlayerTrack>): PlayerTrack => ({
    id: "1",
    path: "/lib/a.aiff",
    title: "Xtal",
    artist: "Aphex Twin",
    album: "Selected Ambient Works 85-92",
    ...over,
  });

  it("says who, and off what", () => {
    expect(subtitleParts(track({}))).toEqual({
      artist: "Aphex Twin",
      album: "Selected Ambient Works 85-92",
    });
  });

  it("drops an album that is not there, rather than a dangling separator", () => {
    expect(subtitleParts(track({ album: "" })).album).toBeNull();
    expect(subtitleParts(track({ album: "   " })).album).toBeNull();
  });

  it("marks a missing artist instead of leaving the line empty", () => {
    expect(subtitleParts(track({ artist: "" })).artist).toBe("—");
    expect(subtitleParts(track({ artist: " " })).artist).toBe("—");
  });
});

describe("skipping through a queue", () => {
  const track = (n: number): PlayerTrack => ({
    id: `t${n}`,
    path: `/lib/t${n}.aiff`,
    title: `T${n}`,
    artist: "",
    album: "",
  });

  let api: ReturnType<typeof usePlayer>;
  function Probe() {
    api = usePlayer();
    return null;
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    // The spies sit on `HTMLMediaElement.prototype`, which outlives the test.
    vi.restoreAllMocks();
  });

  it("loads the track you land on, not every one you pass", () => {
    // The reason this exists is a freeze, not a saving. Sampling the hung app
    // showed the WebKit web process blocked for good in a synchronous IPC —
    // `maybeActivateAudioSession` → `AudioSession::tryToSetActive` →
    // `waitForSyncReply` — while the Tauri side sat idle in its event loop.
    // Every `play()` re-activates the audio session over that round trip, and
    // a handful of skips fires a handful of them into each other.
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");
    render(
      <PlayerProvider>
        <Probe />
      </PlayerProvider>,
    );

    act(() => api.play([track(1), track(2), track(3)], 0));
    act(() => api.next());
    act(() => api.next());
    // Nothing has been asked to play yet: the burst is still being coalesced.
    expect(play).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(LOAD_COALESCE_MS));
    expect(play).toHaveBeenCalledOnce();
    expect(document.querySelector("audio")?.src).toContain("t3.aiff");
  });

  it("still loads a single skip", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play");
    render(
      <PlayerProvider>
        <Probe />
      </PlayerProvider>,
    );

    act(() => api.play([track(1), track(2)], 0));
    act(() => void vi.advanceTimersByTime(LOAD_COALESCE_MS));
    expect(document.querySelector("audio")?.src).toContain("t1.aiff");

    act(() => api.next());
    act(() => void vi.advanceTimersByTime(LOAD_COALESCE_MS));
    expect(document.querySelector("audio")?.src).toContain("t2.aiff");
    expect(play).toHaveBeenCalledTimes(2);
  });
});
