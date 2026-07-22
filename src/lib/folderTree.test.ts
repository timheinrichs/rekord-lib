import { describe, expect, it } from "vitest";
import {
  allFolderPaths,
  buildFolderTree,
  folderTrackList,
} from "./folderTree";
import { makeMetadata, makeTrack } from "../test/factories";

const ROOT = "/lib";

function tree() {
  const tracks = [
    makeTrack({ id: "a", path: "/lib/Collection A/EP 02/02.aiff", metadata: makeMetadata({ track_number: 2, title: "Two" }) }),
    makeTrack({ id: "b", path: "/lib/Collection A/EP 02/01.aiff", metadata: makeMetadata({ track_number: 1, title: "One" }) }),
    makeTrack({ id: "c", path: "/lib/Collection A/Single 01/track.aiff" }),
    makeTrack({ id: "loose", path: "/lib/loose.aiff" }),
  ];
  return buildFolderTree(tracks, ROOT);
}

describe("buildFolderTree", () => {
  it("nests folders and keeps loose tracks at the root", () => {
    const root = tree();
    expect(root.tracks.map((t) => t.id)).toEqual(["loose"]);
    expect(root.folders.map((f) => f.name)).toEqual(["Collection A"]);
    const colA = root.folders[0];
    expect(colA.path).toBe("/lib/Collection A");
    expect(colA.folders.map((f) => f.name)).toEqual(["EP 02", "Single 01"]);
  });

  it("sorts tracks within a folder by track number", () => {
    const ep = tree().folders[0].folders.find((f) => f.name === "EP 02")!;
    expect(ep.tracks.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("tolerates a root dir with a trailing slash", () => {
    const root = buildFolderTree(
      [makeTrack({ id: "x", path: "/lib/Sub/x.aiff" })],
      "/lib/",
    );
    expect(root.folders[0].path).toBe("/lib/Sub");
  });
});

describe("folderTrackList", () => {
  it("collects tracks across subfolders", () => {
    const colA = tree().folders[0];
    expect(folderTrackList(colA).map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("allFolderPaths", () => {
  it("lists every folder path", () => {
    expect(allFolderPaths(tree()).sort()).toEqual([
      "/lib/Collection A",
      "/lib/Collection A/EP 02",
      "/lib/Collection A/Single 01",
    ]);
  });
});
