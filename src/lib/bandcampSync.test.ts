import { describe, expect, it } from "vitest";
import { syncCollection } from "./bandcampSync";
import { makeMetadata, makeTrack } from "../test/factories";
import type { BandcampItem } from "../types";

function item(over: Partial<BandcampItem> = {}): BandcampItem {
  return {
    key: "p1",
    title: "Selected Ambient Works",
    band_name: "Aphex Twin",
    item_type: "album",
    art_url: null,
    download_page_url: null,
    ...over,
  };
}

describe("syncCollection", () => {
  it("matches an album purchase to local tracks by album + artist", () => {
    const tracks = [
      makeTrack({
        id: "t1",
        metadata: makeMetadata({
          album: "Selected Ambient Works",
          album_artist: "Aphex Twin",
        }),
      }),
      makeTrack({
        id: "t2",
        metadata: makeMetadata({
          album: "Selected Ambient Works",
          album_artist: "Aphex Twin",
        }),
      }),
    ];
    const result = syncCollection(tracks, [item()]);
    expect(result.originById).toEqual({ t1: "p1", t2: "p1" });
    expect(result.missing).toHaveLength(0);
  });

  it("matches a single track purchase by title", () => {
    const tracks = [
      makeTrack({
        id: "t1",
        metadata: makeMetadata({
          title: "Xtal",
          album: "Other",
          artist: "Aphex Twin",
          album_artist: "Aphex Twin",
        }),
      }),
    ];
    const result = syncCollection(tracks, [
      item({ key: "t9", title: "Xtal", item_type: "track" }),
    ]);
    expect(result.originById).toEqual({ t1: "t9" });
  });

  it("normalizes diacritics and punctuation when matching", () => {
    const tracks = [
      makeTrack({
        id: "t1",
        metadata: makeMetadata({ album: "Éclair — Deluxe!", album_artist: "Sébastien" }),
      }),
    ];
    const result = syncCollection(tracks, [
      item({ title: "eclair deluxe", band_name: "sebastien" }),
    ]);
    expect(result.originById.t1).toBe("p1");
  });

  it("reports purchases with no local match as missing", () => {
    const tracks = [
      makeTrack({ metadata: makeMetadata({ album: "Something Else" }) }),
    ];
    const items = [item({ key: "p2", title: "Unowned Record" })];
    const result = syncCollection(tracks, items);
    expect(result.originById).toEqual({});
    expect(result.missing.map((m) => m.key)).toEqual(["p2"]);
  });

  it("matches non-Latin (e.g. Cyrillic) titles instead of erasing them", () => {
    const tracks = [
      makeTrack({
        id: "t1",
        metadata: makeMetadata({
          album: "Разом за Україну",
          album_artist: "Standard Deviation",
        }),
      }),
    ];
    const result = syncCollection(tracks, [
      item({ key: "a9", title: "Разом за Україну", band_name: "Standard Deviation" }),
    ]);
    expect(result.originById.t1).toBe("a9");
    expect(result.missing).toHaveLength(0);
  });

  describe("download ledger fallback", () => {
    it("treats a purchase as present when a recorded file still exists", () => {
      // Tags don't match at all (odd formatting), but the file was downloaded.
      const tracks = [
        makeTrack({
          id: "t1",
          path: "/lib/VA/420.aiff",
          metadata: makeMetadata({ album: "420 Hansa Malz", album_artist: "Max Scholpp" }),
        }),
      ];
      const items = [
        item({ key: "a1", title: "Max Scholpp - 420 Hansa Malz", band_name: "Various Artists" }),
      ];
      const bare = syncCollection(tracks, items);
      expect(bare.missing.map((m) => m.key)).toEqual(["a1"]);

      const withLedger = syncCollection(tracks, items, {
        a1: ["/lib/VA/420.aiff"],
      });
      expect(withLedger.originById.t1).toBe("a1");
      expect(withLedger.missing).toHaveLength(0);
    });

    it("re-flags a purchase as missing once its files are gone", () => {
      const tracks = [makeTrack({ id: "t1", path: "/lib/keep.aiff" })];
      const items = [item({ key: "a1", title: "Deleted Album" })];
      const result = syncCollection(tracks, items, {
        a1: ["/lib/gone.aiff"],
      });
      expect(result.originById).toEqual({});
      expect(result.missing.map((m) => m.key)).toEqual(["a1"]);
    });
  });
});
