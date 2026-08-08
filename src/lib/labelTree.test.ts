import { describe, expect, it } from "vitest";
import {
  allLabelIds,
  buildLabelTree,
  labelOf,
  labelTrackList,
  NO_LABEL,
  NO_LABEL_KEY,
} from "./labelTree";
import type { Edits } from "./grouping";
import { makeAudio, makeMetadata, makeTrack } from "../test/factories";

const NO_EDITS: Edits = {};

/** A track with a label/album/title, everything else defaulted. */
function track(
  id: string,
  label: string | null,
  album: string,
  over: Partial<ReturnType<typeof makeMetadata>> = {},
) {
  return makeTrack({
    id,
    path: `/lib/${album}/${id}.aiff`,
    metadata: makeMetadata({ label, album, title: id, ...over }),
  });
}

/** Two labels: "Stroom" with a 2-track album + a single, "Aztec" with one track. */
function scene() {
  return [
    track("s-a2", "Stroom", "Deep EP", { track_number: 2 }),
    track("s-a1", "Stroom", "Deep EP", { track_number: 1 }),
    track("s-solo", "Stroom", "Solo Single"),
    track("a-1", "Aztec", "Aztec EP"),
    track("none", null, "Orphan"),
  ];
}

describe("labelOf", () => {
  it("reads and trims the label tag", () => {
    expect(labelOf(track("x", "  Stroom  ", "A"), NO_EDITS)).toBe("Stroom");
  });

  it("maps missing, empty and whitespace-only labels to the unknown key", () => {
    expect(labelOf(track("x", null, "A"), NO_EDITS)).toBe(NO_LABEL_KEY);
    expect(labelOf(track("x", "", "A"), NO_EDITS)).toBe(NO_LABEL_KEY);
    expect(labelOf(track("x", "   ", "A"), NO_EDITS)).toBe(NO_LABEL_KEY);
  });

  it("prefers a pending edit over the scanned tag", () => {
    const t = track("x", "Old", "A");
    const edits: Edits = {
      x: { metadata: makeMetadata({ label: "New" }), cover: { kind: "keep" } },
    };
    expect(labelOf(t, edits)).toBe("New");
  });
});

describe("buildLabelTree", () => {
  it("returns an empty list for no tracks", () => {
    expect(buildLabelTree([], NO_EDITS, "artist", "asc")).toEqual([]);
  });

  it("creates a node per label, including single-track labels", () => {
    const nodes = buildLabelTree(scene(), NO_EDITS, "artist", "asc");
    expect(nodes.map((n) => n.name)).toEqual(["Aztec", "Stroom", NO_LABEL]);
    const aztec = nodes.find((n) => n.key === "Aztec")!;
    expect(aztec.all.map((t) => t.id)).toEqual(["a-1"]);
  });

  it("gives a tagged album its own node even with a single track", () => {
    const stroom = buildLabelTree(scene(), NO_EDITS, "artist", "asc").find(
      (n) => n.key === "Stroom",
    )!;
    expect(stroom.albums.map((a) => a.album)).toEqual(["Deep EP", "Solo Single"]);
    expect(stroom.albums[0].tracks.map((t) => t.id)).toEqual(["s-a1", "s-a2"]);
    expect(stroom.albums[1].tracks.map((t) => t.id)).toEqual(["s-solo"]);
    expect(stroom.tracks).toEqual([]);
    expect(stroom.all.map((t) => t.id)).toEqual(["s-a1", "s-a2", "s-solo"]);
  });

  it("keeps tracks without an album tag loose under their label", () => {
    // No album tag, so albumOf falls back to the folder name — that must not
    // become an album node.
    const stray = makeTrack({
      id: "stray",
      path: "/lib/Randoms/stray.aiff",
      metadata: makeMetadata({ label: "Stroom", album: null, title: "stray" }),
    });
    const stroom = buildLabelTree(
      [...scene(), stray],
      NO_EDITS,
      "artist",
      "asc",
    ).find((n) => n.key === "Stroom")!;
    expect(stroom.albums.map((a) => a.album)).toEqual(["Deep EP", "Solo Single"]);
    expect(stroom.tracks.map((t) => t.id)).toEqual(["stray"]);
  });

  it("puts null and whitespace-only labels in the same unknown bucket, last", () => {
    const tracks = [
      track("blank", "   ", "A"),
      track("nul", null, "B"),
      track("zzz", "Zzz Records", "C"),
    ];
    for (const dir of ["asc", "desc"] as const) {
      const nodes = buildLabelTree(tracks, NO_EDITS, "artist", dir);
      const last = nodes[nodes.length - 1];
      expect(last.key).toBe(NO_LABEL_KEY);
      expect(last.name).toBe(NO_LABEL);
      expect(last.all.map((t) => t.id).sort()).toEqual(["blank", "nul"]);
    }
  });

  it("keeps the unknown bucket last for the length and date columns too", () => {
    const tracks = [
      makeTrack({
        id: "long-none",
        metadata: makeMetadata({ label: null }),
        audio: makeAudio({ duration_secs: 9999 }),
        download_date: 9999,
      }),
      makeTrack({
        id: "short",
        path: "/lib/b.aiff",
        metadata: makeMetadata({ label: "Stroom" }),
        audio: makeAudio({ duration_secs: 10 }),
        download_date: 10,
      }),
    ];
    for (const key of ["length", "date"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const nodes = buildLabelTree(tracks, NO_EDITS, key, dir);
        expect(nodes[nodes.length - 1].key).toBe(NO_LABEL_KEY);
      }
    }
  });

  it("sorts labels by name for the text columns, honouring the direction", () => {
    for (const key of ["title", "artist", "album"] as const) {
      expect(
        buildLabelTree(scene(), NO_EDITS, key, "asc").map((n) => n.key),
      ).toEqual(["Aztec", "Stroom", NO_LABEL_KEY]);
      expect(
        buildLabelTree(scene(), NO_EDITS, key, "desc").map((n) => n.key),
      ).toEqual(["Stroom", "Aztec", NO_LABEL_KEY]);
    }
  });

  it("sorts labels by summed length and by newest download date", () => {
    const tracks = [
      makeTrack({
        id: "a1",
        metadata: makeMetadata({ label: "A" }),
        audio: makeAudio({ duration_secs: 100 }),
        download_date: 50,
      }),
      makeTrack({
        id: "a2",
        path: "/lib/a2.aiff",
        metadata: makeMetadata({ label: "A" }),
        audio: makeAudio({ duration_secs: 100 }),
        download_date: 10,
      }),
      makeTrack({
        id: "b1",
        path: "/lib/b1.aiff",
        metadata: makeMetadata({ label: "B" }),
        audio: makeAudio({ duration_secs: 150 }),
        download_date: 90,
      }),
    ];
    // A totals 200s vs B's 150s.
    expect(buildLabelTree(tracks, NO_EDITS, "length", "asc").map((n) => n.key)).toEqual([
      "B",
      "A",
    ]);
    // A's newest is 50, B's is 90.
    expect(buildLabelTree(tracks, NO_EDITS, "date", "asc").map((n) => n.key)).toEqual([
      "A",
      "B",
    ]);
    expect(buildLabelTree(tracks, NO_EDITS, "date", "desc").map((n) => n.key)).toEqual([
      "B",
      "A",
    ]);
  });

  it("orders tracks in an album by track number, nulls last, title as tiebreak", () => {
    const tracks = [
      track("zeta", "L", "EP", { track_number: null }),
      track("alpha", "L", "EP", { track_number: null }),
      track("second", "L", "EP", { track_number: 2 }),
      track("first", "L", "EP", { track_number: 1 }),
    ];
    const [node] = buildLabelTree(tracks, NO_EDITS, "artist", "asc");
    expect(node.albums[0].tracks.map((t) => t.id)).toEqual([
      "first",
      "second",
      "alpha",
      "zeta",
    ]);
  });

  it("gives the same album name under two labels distinct node ids", () => {
    const tracks = [
      track("x1", "Label A", "Shared"),
      track("x2", "Label A", "Shared"),
      track("y1", "Label B", "Shared"),
      track("y2", "Label B", "Shared"),
    ];
    const nodes = buildLabelTree(tracks, NO_EDITS, "artist", "asc");
    const ids = nodes.flatMap((n) => n.albums.map((a) => a.id));
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  it("regroups by a pending label edit without a rescan", () => {
    const tracks = [track("x", "Old", "A"), track("y", "Other", "B")];
    const edits: Edits = {
      x: { metadata: makeMetadata({ label: "Other" }), cover: { kind: "keep" } },
    };
    const nodes = buildLabelTree(tracks, edits, "artist", "asc");
    expect(nodes.map((n) => n.key)).toEqual(["Other"]);
    expect(nodes[0].all.map((t) => t.id).sort()).toEqual(["x", "y"]);
  });
});

describe("labelTrackList", () => {
  it("returns every track exactly once, albums before loose tracks", () => {
    const nodes = buildLabelTree(scene(), NO_EDITS, "artist", "asc");
    expect(labelTrackList(nodes).map((t) => t.id)).toEqual([
      "a-1",
      "s-a1",
      "s-a2",
      "s-solo",
      "none",
    ]);
  });
});

describe("allLabelIds", () => {
  it("lists label and album ids without duplicates", () => {
    const nodes = buildLabelTree(scene(), NO_EDITS, "artist", "asc");
    const ids = allLabelIds(nodes);
    // 3 labels + 4 albums (every track in the scene carries an album tag:
    // "Deep EP", "Solo Single", "Aztec EP", "Orphan").
    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect(ids).toContain(nodes[0].id);
    expect(ids).toContain(nodes.find((n) => n.key === "Stroom")!.albums[0].id);
  });
});
