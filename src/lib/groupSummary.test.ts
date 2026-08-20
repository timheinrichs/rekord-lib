import { describe, expect, it } from "vitest";
import { albumsLabel, summarizeGroup } from "./groupSummary";
import type { Edits } from "./grouping";
import { makeAudio, makeCompat, makeMetadata, makeTrack } from "../test/factories";

const NO_EDITS: Edits = {};
const never = () => false;

describe("summarizeGroup", () => {
  it("returns neutral values for an empty group", () => {
    const s = summarizeGroup([], NO_EDITS, never);
    expect(s).toMatchObject({
      count: 0,
      totalLength: 0,
      newestDate: null,
      format: "–",
      albumArtist: "",
      albums: [],
      needConvert: 0,
      needIncomplete: 0,
    });
  });

  it("reports a shared format, else Mixed", () => {
    const aiff16 = makeTrack({ id: "a", audio: makeAudio({ bits_per_sample: 16 }) });
    const aiff24 = makeTrack({
      id: "b",
      path: "/lib/b.aiff",
      audio: makeAudio({ bits_per_sample: 24 }),
    });
    expect(summarizeGroup([aiff16], NO_EDITS, never).format).toBe("AIFF 16-bit");
    expect(summarizeGroup([aiff16, aiff24], NO_EDITS, never).format).toBe("Mixed");
  });

  it("reports a shared album artist, else Various", () => {
    const a = makeTrack({ id: "a", metadata: makeMetadata({ album_artist: "AKA Zeb" }) });
    const b = makeTrack({
      id: "b",
      path: "/lib/b.aiff",
      metadata: makeMetadata({ album_artist: "Other" }),
    });
    expect(summarizeGroup([a], NO_EDITS, never).albumArtist).toBe("AKA Zeb");
    expect(summarizeGroup([a, b], NO_EDITS, never).albumArtist).toBe("Various");
  });

  it("leaves the album artist empty when no track has one", () => {
    const t = makeTrack({
      id: "a",
      metadata: makeMetadata({ album_artist: null, artist: null }),
    });
    expect(summarizeGroup([t], NO_EDITS, never).albumArtist).toBe("");
  });

  it("collects distinct album names without blanks", () => {
    const mk = (id: string, album: string | null) =>
      makeTrack({ id, path: `/lib/x/${id}.aiff`, metadata: makeMetadata({ album }) });
    const s = summarizeGroup(
      [mk("a", "EP One"), mk("b", "EP One"), mk("c", "EP Two")],
      NO_EDITS,
      never,
    );
    expect(s.albums).toEqual(["EP One", "EP Two"]);
  });

  it("sums the length and takes the newest download date", () => {
    const a = makeTrack({
      id: "a",
      audio: makeAudio({ duration_secs: 100 }),
      download_date: 50,
    });
    const b = makeTrack({
      id: "b",
      path: "/lib/b.aiff",
      audio: makeAudio({ duration_secs: 40 }),
      download_date: 90,
    });
    const s = summarizeGroup([a, b], NO_EDITS, never);
    expect(s.totalLength).toBe(140);
    expect(s.newestDate).toBe(90);
  });

  it("reports a null date when no track has one (never -Infinity or 0)", () => {
    const t = makeTrack({ id: "a", download_date: null });
    expect(summarizeGroup([t], NO_EDITS, never).newestDate).toBeNull();
  });

  it("counts tracks needing conversion and the injected incomplete predicate", () => {
    const ok = makeTrack({ id: "ok" });
    const bad = makeTrack({
      id: "bad",
      path: "/lib/bad.aiff",
      compat: makeCompat({ compatible: false }),
    });
    const s = summarizeGroup([ok, bad], NO_EDITS, (t) => t.id === "ok");
    expect(s.needConvert).toBe(1);
    expect(s.needIncomplete).toBe(1);
    expect(s.count).toBe(2);
  });

  it("uses pending edits for the album artist and album", () => {
    const t = makeTrack({
      id: "x",
      metadata: makeMetadata({ album_artist: "Old", album: "Old Album" }),
    });
    const edits: Edits = {
      x: {
        metadata: makeMetadata({ album_artist: "New", album: "New Album" }),
        cover: { kind: "keep" },
      },
    };
    const s = summarizeGroup([t], edits, never);
    expect(s.albumArtist).toBe("New");
    expect(s.albums).toEqual(["New Album"]);
  });
});

describe("albumsLabel", () => {
  it("names a single album, counts several and dashes none", () => {
    expect(albumsLabel(["EP One"])).toBe("EP One");
    expect(albumsLabel(["EP One", "EP Two"])).toBe("2 albums");
    expect(albumsLabel([])).toBe("–");
  });
});

describe("summarizeGroup bpm", () => {
  const bpmTrack = (id: string, bpm: number | null) =>
    makeTrack({ id, path: `/lib/${id}.aiff`, metadata: makeMetadata({ bpm }) });

  it("shows a single value when the group agrees", () => {
    expect(summarizeGroup([bpmTrack("a", 128), bpmTrack("b", 128)], NO_EDITS, never).bpm).toBe(
      "128",
    );
  });

  it("shows a range when the tempos differ", () => {
    const group = [bpmTrack("a", 130), bpmTrack("b", 126), bpmTrack("c", 128)];
    expect(summarizeGroup(group, NO_EDITS, never).bpm).toBe("126–130");
  });

  it("ignores tracks without a BPM and dashes when none has one", () => {
    expect(summarizeGroup([bpmTrack("a", 128), bpmTrack("b", null)], NO_EDITS, never).bpm).toBe(
      "128",
    );
    expect(summarizeGroup([bpmTrack("a", null)], NO_EDITS, never).bpm).toBe("–");
    expect(summarizeGroup([], NO_EDITS, never).bpm).toBe("–");
  });

  it("uses a pending edit over the scanned tag", () => {
    const edits: Edits = {
      a: { metadata: makeMetadata({ bpm: 174 }), cover: { kind: "keep" } },
    };
    expect(summarizeGroup([bpmTrack("a", 90)], edits, never).bpm).toBe("174");
  });
});

describe("summarizeGroup bpm with fractional tempos", () => {
  const bpmTrack = (id: string, bpm: number | null) =>
    makeTrack({ id, path: `/lib/${id}.aiff`, metadata: makeMetadata({ bpm }) });
  const never = () => false;

  it("reads as one tempo when the tracks only differ in decimals", () => {
    // Detection now returns fractions, so an album that used to show "128"
    // would otherwise show "127.96–128.04" — a range that means nothing.
    const group = [bpmTrack("a", 127.96), bpmTrack("b", 128.04)];
    expect(summarizeGroup(group, NO_EDITS, never).bpm).toBe("128");
  });

  it("still shows a real spread", () => {
    const group = [bpmTrack("a", 126.4), bpmTrack("b", 130.2)];
    expect(summarizeGroup(group, NO_EDITS, never).bpm).toBe("126–130");
  });
});
