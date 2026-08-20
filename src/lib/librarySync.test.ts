import { describe, expect, it } from "vitest";
import {
  applyPatch,
  convertedOutputs,
  diffAudioFiles,
  mergeConverted,
  mergeScanned,
  pathsMissingBpm,
} from "./librarySync";
import { makeMetadata, makeTrack } from "../test/factories";
import type { ConvertResult, TrackPatch } from "../types";

/** A patch that reports nothing, so a test only sets what it is about. */
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

function result(over: Partial<ConvertResult>): ConvertResult {
  return {
    id: "id",
    source_path: "/lib/a.aiff",
    output_path: "/lib/a.aiff",
    success: true,
    error: null,
    ...over,
  };
}

describe("diffAudioFiles", () => {
  it("treats a folder it could not list as no evidence at all", () => {
    const a = makeTrack({ id: "/lib/a.aiff", path: "/lib/a.aiff" });
    const b = makeTrack({ id: "/lib/b.aiff", path: "/lib/b.aiff" });

    // null is not an empty listing: an unreadable folder must not read as
    // "every file was deleted", which would forget the whole library.
    const diff = diffAudioFiles(null, [a, b]);
    expect(diff.removedPaths).toEqual([]);
    expect(diff.addedPaths).toEqual([]);
    expect(diff.keptTracks).toEqual([a, b]);
    expect(diff.changed).toBe(false);

    // An empty listing, by contrast, is evidence — those files really are gone.
    expect(diffAudioFiles([], [a, b]).removedPaths).toEqual([
      "/lib/a.aiff",
      "/lib/b.aiff",
    ]);
  });

  const a = makeTrack({ id: "/lib/a.aiff", path: "/lib/a.aiff" });
  const b = makeTrack({ id: "/lib/b.aiff", path: "/lib/b.aiff" });

  it("detects new files to analyze", () => {
    const d = diffAudioFiles(["/lib/a.aiff", "/lib/c.aiff"], [a]);
    expect(d.addedPaths).toEqual(["/lib/c.aiff"]);
    expect(d.keptTracks.map((t) => t.path)).toEqual(["/lib/a.aiff"]);
    expect(d.changed).toBe(true);
  });

  it("drops deleted files (kept = still on disk)", () => {
    const d = diffAudioFiles(["/lib/a.aiff"], [a, b]);
    expect(d.addedPaths).toEqual([]);
    expect(d.keptTracks.map((t) => t.path)).toEqual(["/lib/a.aiff"]);
    expect(d.changed).toBe(true);
  });

  it("names the paths that are gone, so they can leave the database", () => {
    const d = diffAudioFiles(["/lib/a.aiff"], [a, b]);
    expect(d.removedPaths).toEqual(["/lib/b.aiff"]);
  });

  it("reports no change when disk matches the library", () => {
    const d = diffAudioFiles(["/lib/a.aiff", "/lib/b.aiff"], [a, b]);
    expect(d.addedPaths).toEqual([]);
    expect(d.keptTracks).toHaveLength(2);
    expect(d.removedPaths).toEqual([]);
    expect(d.changed).toBe(false);
  });

  it("reports a change when a file was only removed", () => {
    // Both counts move together here; the flag must not depend on additions.
    const d = diffAudioFiles([], [a, b]);
    expect(d.addedPaths).toEqual([]);
    expect(d.removedPaths).toEqual(["/lib/a.aiff", "/lib/b.aiff"]);
    expect(d.changed).toBe(true);
  });

  it("reports nothing for an empty library and an empty disk", () => {
    const d = diffAudioFiles([], []);
    expect(d.changed).toBe(false);
    expect(d.removedPaths).toEqual([]);
  });
});

describe("convertedOutputs", () => {
  it("collects output paths of successful conversions only", () => {
    const outputs = convertedOutputs([
      result({ output_path: "/lib/a.aiff" }),
      result({ success: false, output_path: "/lib/b.aiff" }),
      result({ output_path: null }),
    ]);
    expect(outputs).toEqual(["/lib/a.aiff"]);
  });

  it("de-duplicates repeated outputs", () => {
    const outputs = convertedOutputs([
      result({ output_path: "/lib/a.aiff" }),
      result({ output_path: "/lib/a.aiff" }),
    ]);
    expect(outputs).toEqual(["/lib/a.aiff"]);
  });
});

describe("mergeConverted", () => {
  const a = makeTrack({ id: "/lib/a.wav", path: "/lib/a.wav" });
  const b = makeTrack({ id: "/lib/b.aiff", path: "/lib/b.aiff" });

  it("replaces an in-place conversion (same path) with its re-analysis", () => {
    const fresh = makeTrack({ id: "/lib/b.aiff", path: "/lib/b.aiff" });
    const out = mergeConverted(
      [a, b],
      [result({ source_path: "/lib/b.aiff", output_path: "/lib/b.aiff" })],
      [fresh],
    );
    expect(out.map((t) => t.path)).toEqual(["/lib/a.wav", "/lib/b.aiff"]);
    expect(out[1]).toBe(fresh);
  });

  it("drops the old source path on a format change and adds the output", () => {
    const fresh = makeTrack({ id: "/lib/a.aiff", path: "/lib/a.aiff" });
    const out = mergeConverted(
      [a, b],
      [result({ source_path: "/lib/a.wav", output_path: "/lib/a.aiff" })],
      [fresh],
    );
    expect(out.map((t) => t.path)).toEqual(["/lib/b.aiff", "/lib/a.aiff"]);
  });

  it("returns the same reference when nothing succeeded", () => {
    const tracks = [a, b];
    expect(
      mergeConverted(tracks, [result({ success: false, output_path: null })], []),
    ).toBe(tracks);
  });
});

describe("mergeScanned", () => {
  const t = (path: string, bpm: number | null = null) =>
    makeTrack({ id: path, path, metadata: makeMetadata({ bpm }) });

  it("replaces a track by path and keeps the order", () => {
    const before = [t("/a.aiff"), t("/b.aiff"), t("/c.aiff")];
    const merged = mergeScanned(before, [t("/b.aiff", 128)]);
    expect(merged.map((x) => x.path)).toEqual(["/a.aiff", "/b.aiff", "/c.aiff"]);
    expect(merged[1].metadata.bpm).toBe(128);
  });

  it("appends tracks it has not seen before", () => {
    const merged = mergeScanned([t("/a.aiff")], [t("/new.aiff", 120)]);
    expect(merged.map((x) => x.path)).toEqual(["/a.aiff", "/new.aiff"]);
  });

  it("never drops tracks the batch does not mention", () => {
    // A targeted run only covers a subset — the rest must survive.
    const before = [t("/a.aiff"), t("/b.aiff")];
    expect(mergeScanned(before, [t("/a.aiff", 90)]).map((x) => x.path)).toEqual([
      "/a.aiff",
      "/b.aiff",
    ]);
  });

  it("is reference-stable when nothing changes", () => {
    const before = [t("/a.aiff")];
    expect(mergeScanned(before, [])).toBe(before);
    expect(mergeScanned(before, [before[0]])).toBe(before);
  });

  it("handles a batch that is entirely new", () => {
    expect(mergeScanned([], [t("/a.aiff"), t("/b.aiff")])).toHaveLength(2);
  });
});

describe("pathsMissingBpm", () => {
  it("lists exactly the tracks without a tempo", () => {
    const tracks = [
      makeTrack({ id: "a", path: "/a.aiff", metadata: makeMetadata({ bpm: 128 }) }),
      makeTrack({ id: "b", path: "/b.aiff", metadata: makeMetadata({ bpm: null }) }),
      makeTrack({ id: "c", path: "/c.aiff", metadata: makeMetadata({ bpm: 0 }) }),
    ];
    // 0 is not a real tempo but it is a value; only null counts as missing.
    expect(pathsMissingBpm(tracks)).toEqual(["/b.aiff"]);
  });

  it("returns an empty list when everything is tagged", () => {
    expect(pathsMissingBpm([])).toEqual([]);
  });
});

describe("applyPatch", () => {
  it("fills in one field without disturbing the rest of the row", () => {
    const before = [
      makeTrack({
        path: "/lib/a.aiff",
        metadata: makeMetadata({ title: "Running", bpm: null }),
      }),
    ];

    const after = applyPatch(before, [
      patch({ path: "/lib/a.aiff", bpm: 127.6, bpm_confidence: 0.8 }),
    ]);

    expect(after[0].metadata.bpm).toBe(127.6);
    expect(after[0].bpm_confidence).toBe(0.8);
    // Everything the patch said nothing about is still there.
    expect(after[0].metadata.title).toBe("Running");
    expect(after[0].key).toBeNull();
  });

  it("treats a null field as unchanged, not as cleared", () => {
    // The pass never clears a value it failed to find: a key-only result must
    // not wipe a tempo the file already carried.
    const before = [
      makeTrack({
        path: "/lib/a.aiff",
        metadata: makeMetadata({ bpm: 120 }),
      }),
    ];

    const after = applyPatch(before, [
      patch({
        path: "/lib/a.aiff",
        key: "Am",
        key_camelot: "8A",
        key_confidence: 0.6,
      }),
    ]);

    expect(after[0].metadata.bpm).toBe(120);
    expect(after[0].key).toBe("Am");
    expect(after[0].key_camelot).toBe("8A");
  });

  it("ignores a patch for a path it does not know", () => {
    // A stale generation, not a missing row: the tempo pass runs after every
    // row exists.
    const before = [makeTrack({ path: "/lib/a.aiff" })];
    expect(applyPatch(before, [patch({ path: "/lib/gone.aiff", bpm: 130 })])).toBe(
      before,
    );
  });

  it("is reference-stable for a patch that changes no column", () => {
    // A waveform lives in its own table, so it must not re-derive the list.
    const before = [makeTrack({ path: "/lib/a.aiff" })];
    expect(applyPatch(before, [])).toBe(before);
    expect(applyPatch(before, [patch({ waveform: true })])).toBe(before);
  });

  it("patches several rows in one pass and leaves the others identical", () => {
    const a = makeTrack({ path: "/lib/a.aiff" });
    const b = makeTrack({ path: "/lib/b.aiff" });
    const c = makeTrack({ path: "/lib/c.aiff" });

    const after = applyPatch([a, b, c], [
      patch({ path: "/lib/a.aiff", bpm: 128 }),
      patch({ path: "/lib/c.aiff", key: "Am", key_camelot: "8A" }),
    ]);

    expect(after[0].metadata.bpm).toBe(128);
    expect(after[2].key).toBe("Am");
    // Untouched rows keep their identity, so their cells do not re-render.
    expect(after[1]).toBe(b);
  });
});
