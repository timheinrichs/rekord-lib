import { describe, expect, it } from "vitest";

import { makeMetadata, makeTrack } from "../test/factories";
import type { WriteMetadataResult } from "./api";
import {
  applyWrittenTracks,
  writeErrorMessage,
  writtenIds,
} from "./writeResults";

const a = makeTrack({ path: "/music/a.aiff", id: "/music/a.aiff" });
const b = makeTrack({ path: "/music/b.aiff", id: "/music/b.aiff" });

function ok(track = a): WriteMetadataResult {
  return { path: track.path, track, error: null };
}

function failed(path: string, error = "no writable tag"): WriteMetadataResult {
  return { path, track: null, error };
}

describe("applyWrittenTracks", () => {
  it("replaces a written row with its re-analyzed version", () => {
    const rewritten = makeTrack({
      path: a.path,
      id: a.id,
      metadata: makeMetadata({ title: "New title" }),
    });
    const out = applyWrittenTracks([a, b], [ok(rewritten)]);
    expect(out[0].metadata.title).toBe("New title");
    expect(out[1]).toBe(b);
  });

  it("leaves rows the batch did not mention untouched", () => {
    const out = applyWrittenTracks([a, b], [ok(a)]);
    expect(out[1]).toBe(b);
  });

  it("keeps the old row when the write failed", () => {
    const out = applyWrittenTracks([a, b], [failed(a.path)]);
    expect(out[0]).toBe(a);
  });

  it("returns an empty list unchanged", () => {
    expect(applyWrittenTracks([], [ok(a)])).toEqual([]);
  });
});

describe("writtenIds", () => {
  it("lists only the ids that actually reached disk", () => {
    expect(writtenIds([ok(a), failed(b.path)])).toEqual([a.id]);
  });

  it("is empty when nothing was written", () => {
    expect(writtenIds([])).toEqual([]);
    expect(writtenIds([failed(a.path)])).toEqual([]);
  });
});

describe("writeErrorMessage", () => {
  it("is null when every file was written", () => {
    expect(writeErrorMessage([ok(a), ok(b)])).toBeNull();
    expect(writeErrorMessage([])).toBeNull();
  });

  it("counts the failures and joins their reasons", () => {
    const msg = writeErrorMessage([
      ok(a),
      failed(b.path, "permission denied"),
      failed("/music/c.aiff", "no writable tag"),
    ]);
    expect(msg).toContain("2 file(s)");
    expect(msg).toContain("permission denied");
    expect(msg).toContain("no writable tag");
  });

  it("treats an empty error string as no failure", () => {
    // The backend only ever sends a non-empty reason; an empty one would
    // otherwise produce a message with nothing in it.
    expect(writeErrorMessage([{ path: a.path, track: null, error: "" }])).toBeNull();
  });
});
