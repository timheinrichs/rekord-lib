import { describe, expect, it } from "vitest";
import {
  albumArtistOf,
  albumOf,
  buildAlbumItems,
  compareValues,
  isNumericSort,
  pruneGroups,
  sortTracks,
} from "./grouping";
import { makeAudio, makeMetadata, makeTrack } from "../test/factories";
import type { DuplicateFile, DuplicateGroup } from "../types";

const NO_EDITS = {};

// Two tracks of album "Beta" (out of track order) + one single-track "Alpha".
function scene() {
  const a1 = makeTrack({
    id: "a1",
    metadata: makeMetadata({ album: "Beta", title: "z-song", track_number: 2, album_artist: "Zed" }),
    audio: makeAudio({ duration_secs: 100 }),
  });
  const a2 = makeTrack({
    id: "a2",
    metadata: makeMetadata({ album: "Beta", title: "a-song", track_number: 1, album_artist: "Zed" }),
    audio: makeAudio({ duration_secs: 100 }),
  });
  const solo = makeTrack({
    id: "solo",
    metadata: makeMetadata({ album: "Alpha", title: "Solo", album_artist: "Mike" }),
    audio: makeAudio({ duration_secs: 50 }),
  });
  return { a1, a2, solo };
}

describe("compareValues", () => {
  it("sorts empty values last regardless of direction", () => {
    expect(compareValues("", "a", 1)).toBe(1);
    expect(compareValues("a", "", 1)).toBe(-1);
    expect(compareValues("", "a", -1)).toBe(1);
    expect(compareValues("", "", 1)).toBe(0);
  });

  it("is numeric-aware and respects direction", () => {
    expect(compareValues("2", "10", 1)).toBeLessThan(0);
    expect(compareValues("a", "b", -1)).toBeGreaterThan(0);
  });
});

describe("albumOf / albumArtistOf", () => {
  it("uses the album tag, else the parent folder", () => {
    const tagged = makeTrack({ metadata: makeMetadata({ album: "Tagged" }) });
    expect(albumOf(tagged, NO_EDITS)).toBe("Tagged");
    const untagged = makeTrack({
      path: "/music/Folder Name/track.aiff",
      metadata: makeMetadata({ album: null }),
    });
    expect(albumOf(untagged, NO_EDITS)).toBe("Folder Name");
  });

  it("prefers album_artist, falls back to artist", () => {
    expect(
      albumArtistOf(makeTrack({ metadata: makeMetadata({ album_artist: "AA" }) }), NO_EDITS),
    ).toBe("AA");
    expect(
      albumArtistOf(
        makeTrack({ metadata: makeMetadata({ album_artist: null, artist: "Just Artist" }) }),
        NO_EDITS,
      ),
    ).toBe("Just Artist");
  });

  it("respects pending edits over scanned metadata", () => {
    const t = makeTrack({ id: "x", metadata: makeMetadata({ album: "Old" }) });
    const edits = { x: { metadata: makeMetadata({ album: "New" }), cover: { kind: "keep" as const } } };
    expect(albumOf(t, edits)).toBe("New");
  });
});

describe("buildAlbumItems", () => {
  it("groups albums with >= 2 tracks and keeps singles as track rows", () => {
    const { a1, a2, solo } = scene();
    const items = buildAlbumItems([a1, a2, solo], NO_EDITS, "album", "asc");
    const group = items.find((i) => i.type === "group");
    const single = items.find((i) => i.type === "track");
    expect(group && group.type === "group" && group.key).toBe("Beta");
    expect(single && single.type === "track" && single.track.id).toBe("solo");
  });

  it("hard-sorts tracks within a group by track number", () => {
    const { a1, a2 } = scene();
    const [group] = buildAlbumItems([a1, a2], NO_EDITS, "title", "desc");
    expect(group.type).toBe("group");
    if (group.type === "group") {
      expect(group.tracks.map((t) => t.id)).toEqual(["a2", "a1"]);
    }
  });

  it("sorts the top level by album ascending", () => {
    const { a1, a2, solo } = scene();
    const items = buildAlbumItems([a1, a2, solo], NO_EDITS, "album", "asc");
    // Alpha (single) before Beta (group)
    expect(items[0].type).toBe("track");
    expect(items[1].type).toBe("group");
  });

  it("sorts the top level by total length", () => {
    const { a1, a2, solo } = scene();
    const asc = buildAlbumItems([a1, a2, solo], NO_EDITS, "length", "asc");
    // single (50s) before group (200s total)
    expect(asc[0].type).toBe("track");
    const desc = buildAlbumItems([a1, a2, solo], NO_EDITS, "length", "desc");
    expect(desc[0].type).toBe("group");
  });
});

describe("sort by download date", () => {
  it("sorts flat tracks by date", () => {
    const t1 = makeTrack({ id: "t1", path: "/x/1.aiff", download_date: 100 });
    const t2 = makeTrack({ id: "t2", path: "/x/2.aiff", download_date: 300 });
    expect(sortTracks([t2, t1], NO_EDITS, "date", "asc").map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(sortTracks([t1, t2], NO_EDITS, "date", "desc").map((t) => t.id)).toEqual(["t2", "t1"]);
  });

  it("uses the album's newest track date at the top level", () => {
    const beta1 = makeTrack({
      id: "b1",
      path: "/lib/Beta/1.aiff",
      metadata: makeMetadata({ album: "Beta", track_number: 1 }),
      download_date: 100,
    });
    const beta2 = makeTrack({
      id: "b2",
      path: "/lib/Beta/2.aiff",
      metadata: makeMetadata({ album: "Beta", track_number: 2 }),
      download_date: 300,
    });
    const solo = makeTrack({
      id: "solo",
      path: "/lib/Alpha/s.aiff",
      metadata: makeMetadata({ album: "Alpha" }),
      download_date: 500,
    });
    const items = buildAlbumItems([beta1, beta2, solo], NO_EDITS, "date", "asc");
    // Album Beta (max date 300) before the single (500).
    expect(items[0].type).toBe("group");
    expect(items[1].type).toBe("track");
  });
});

describe("sortTracks (flat)", () => {
  it("sorts by title ascending and descending", () => {
    const { a1, a2, solo } = scene();
    const asc = sortTracks([a1, a2, solo], NO_EDITS, "title", "asc").map((t) => t.id);
    expect(asc).toEqual(["a2", "solo", "a1"]); // a-song, Solo, z-song
    const desc = sortTracks([a1, a2, solo], NO_EDITS, "title", "desc").map((t) => t.id);
    expect(desc).toEqual(["a1", "solo", "a2"]);
  });
});

describe("pruneGroups", () => {
  function file(id: string, path: string): DuplicateFile {
    return {
      id,
      path,
      file_name: path,
      codec: "flac",
      container: "flac",
      sample_rate: 44_100,
      bits_per_sample: 16,
      lossless: true,
      duration_secs: 100,
      compatible: true,
      size_bytes: 1,
    };
  }
  const group = (over: Partial<DuplicateGroup> = {}): DuplicateGroup => ({
    id: "g",
    files: [file("1", "/a"), file("2", "/b"), file("3", "/c")],
    keep_id: "1",
    ...over,
  });

  it("returns the same reference when nothing changed", () => {
    const groups = [group()];
    expect(pruneGroups(groups, () => true)).toBe(groups);
  });

  it("drops removed files and shrinks the group", () => {
    const out = pruneGroups([group()], (p) => p !== "/c");
    expect(out[0].files.map((f) => f.id)).toEqual(["1", "2"]);
  });

  it("discards groups that fall below two files", () => {
    const out = pruneGroups([group()], (p) => p === "/a");
    expect(out).toHaveLength(0);
  });

  it("corrects keep_id when the kept file is gone", () => {
    const out = pruneGroups([group({ keep_id: "1" })], (p) => p !== "/a");
    expect(out[0].keep_id).toBe("2");
  });
});

describe("BPM sorting", () => {
  const bpmTrack = (id: string, bpm: number | null, album = id) =>
    makeTrack({
      id,
      path: `/lib/${album}/${id}.aiff`,
      metadata: makeMetadata({ album, title: id, bpm }),
    });

  it("is treated as a numeric column", () => {
    expect(isNumericSort("bpm")).toBe(true);
    expect(isNumericSort("length")).toBe(true);
    expect(isNumericSort("artist")).toBe(false);
  });

  it("sorts a flat list by tempo in both directions", () => {
    const tracks = [bpmTrack("fast", 174), bpmTrack("slow", 90), bpmTrack("mid", 128)];
    expect(sortTracks(tracks, NO_EDITS, "bpm", "asc").map((t) => t.id)).toEqual([
      "slow",
      "mid",
      "fast",
    ]);
    expect(sortTracks(tracks, NO_EDITS, "bpm", "desc").map((t) => t.id)).toEqual([
      "fast",
      "mid",
      "slow",
    ]);
  });

  it("puts tracks without a BPM last, whichever direction", () => {
    const tracks = [bpmTrack("none", null), bpmTrack("fast", 174), bpmTrack("slow", 90)];
    for (const dir of ["asc", "desc"] as const) {
      const ids = sortTracks(tracks, NO_EDITS, "bpm", dir).map((t) => t.id);
      expect(ids[ids.length - 1]).toBe("none");
    }
  });

  it("prefers a pending edit over the scanned tag", () => {
    const tracks = [bpmTrack("edited", 90), bpmTrack("other", 128)];
    const edits = {
      edited: { metadata: makeMetadata({ bpm: 174 }), cover: { kind: "keep" as const } },
    };
    expect(sortTracks(tracks, edits, "bpm", "asc").map((t) => t.id)).toEqual([
      "other",
      "edited",
    ]);
  });

  it("sorts album groups by their mean tempo", () => {
    // Group "Beta" averages 130, the single track sits at 100.
    const b1 = bpmTrack("b1", 120, "Beta");
    const b2 = bpmTrack("b2", 140, "Beta");
    const solo = bpmTrack("solo", 100, "Alpha");
    const items = buildAlbumItems([b1, b2, solo], NO_EDITS, "bpm", "asc");
    const first = items[0];
    expect(first.type === "track" && first.track.id).toBe("solo");
  });

  it("sorts a group with no BPM at all last", () => {
    const withBpm = bpmTrack("has", 128, "Alpha");
    const n1 = bpmTrack("n1", null, "Beta");
    const n2 = bpmTrack("n2", null, "Beta");
    const items = buildAlbumItems([n1, n2, withBpm], NO_EDITS, "bpm", "asc");
    const last = items[items.length - 1];
    expect(last.type).toBe("group");
  });

  it("leaves the Downloaded column's ordering untouched", () => {
    // Missing dates keep their long-standing 0, i.e. first ascending.
    const dated = makeTrack({ id: "dated", download_date: 500 });
    const undated = makeTrack({ id: "undated", path: "/lib/u.aiff", download_date: null });
    expect(sortTracks([dated, undated], NO_EDITS, "date", "asc").map((t) => t.id)).toEqual([
      "undated",
      "dated",
    ]);
  });
});
