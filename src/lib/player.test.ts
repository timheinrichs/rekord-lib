import { describe, expect, it } from "vitest";
import { clampIndex, subtitleParts, type PlayerTrack } from "./player";

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
