import { describe, expect, it } from "vitest";

import { addSkipped, skippedAsText, skippedLabel } from "./skipped";
import type { SkippedFile } from "../types";

function skip(path: string, reason = "Failed to analyze file"): SkippedFile {
  return { path, file_name: path.split("/").pop() ?? path, reason };
}

describe("addSkipped", () => {
  it("collects one entry per file", () => {
    const list = addSkipped(addSkipped([], skip("/a.aiff")), skip("/b.aiff"));
    expect(list.map((f) => f.path)).toEqual(["/a.aiff", "/b.aiff"]);
  });

  it("does not grow when the same file is reported again", () => {
    const first = addSkipped([], skip("/a.aiff"));
    const second = addSkipped(first, skip("/a.aiff"));
    expect(second).toHaveLength(1);
    // Unchanged input, unchanged reference — no re-render for a repeat.
    expect(second).toBe(first);
  });

  it("keeps the newest reason for a file", () => {
    const first = addSkipped([], skip("/a.aiff", "no streams found"));
    const second = addSkipped(first, skip("/a.aiff", "ffprobe not executable"));
    expect(second).toHaveLength(1);
    expect(second[0].reason).toBe("ffprobe not executable");
  });
});

describe("skippedLabel", () => {
  it("says nothing when nothing was skipped", () => {
    expect(skippedLabel([])).toBeNull();
  });

  it("counts in the singular and the plural", () => {
    expect(skippedLabel([skip("/a.aiff")])).toBe("1 file skipped");
    expect(skippedLabel([skip("/a.aiff"), skip("/b.aiff")])).toBe(
      "2 files skipped",
    );
  });
});

describe("skippedAsText", () => {
  it("renders one file per line with its reason", () => {
    const text = skippedAsText([
      skip("/lib/a.aiff", "no streams found"),
      skip("/lib/b.wav", "ffprobe failed"),
    ]);
    expect(text).toBe(
      "/lib/a.aiff — no streams found\n/lib/b.wav — ffprobe failed",
    );
  });

  it("is empty for an empty list", () => {
    expect(skippedAsText([])).toBe("");
  });
});
