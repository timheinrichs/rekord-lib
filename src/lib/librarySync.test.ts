import { describe, expect, it } from "vitest";
import {
  convertedOutputs,
  diffAudioFiles,
  mergeConverted,
} from "./librarySync";
import { makeTrack } from "../test/factories";
import type { ConvertResult } from "../types";

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

  it("reports no change when disk matches the library", () => {
    const d = diffAudioFiles(["/lib/a.aiff", "/lib/b.aiff"], [a, b]);
    expect(d.addedPaths).toEqual([]);
    expect(d.keptTracks).toHaveLength(2);
    expect(d.changed).toBe(false);
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
