import { describe, expect, it } from "vitest";
import { diffAudioFiles } from "./librarySync";
import { makeTrack } from "../test/factories";

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
