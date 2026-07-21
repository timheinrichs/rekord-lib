import { describe, expect, it } from "vitest";
import {
  clusterAlbums,
  deleteSetForAlbum,
  foldersToPrune,
  trackGroupsOutsideAlbums,
} from "./dupAlbums";
import type { DuplicateFile, DuplicateGroup } from "../types";

function dfile(path: string, over: Partial<DuplicateFile> = {}): DuplicateFile {
  return {
    id: path,
    path,
    file_name: path.split("/").pop() ?? path,
    codec: "flac",
    container: "flac",
    sample_rate: 44_100,
    bits_per_sample: 16,
    lossless: true,
    duration_secs: 100,
    compatible: true,
    size_bytes: 1000,
    title: null,
    artist: null,
    album: null,
    ...over,
  };
}

function group(files: DuplicateFile[]): DuplicateGroup {
  const id = [...files.map((f) => f.path)].sort()[0];
  return { id, files, keep_id: files[0].id };
}

// Clean FLAC album vs. mangled AIFF album, 3 matched tracks.
function scene() {
  const mk = (n: number, title: string) =>
    group([
      dfile(`/lib/clean/${n}.flac`, {
        title,
        album: "Italo House compiled by Joey Negro",
        codec: "flac",
      }),
      dfile(`/lib/old/${n}.aiff`, {
        title: `Don Carlos - Italo House compiled by Joey Negro - 0${n} ${title}`,
        album: "Z Records - Italo House compiled by Joey Negro",
        codec: "pcm_s16be",
        container: "aiff",
      }),
    ]);
  return [mk(1, "Alone"), mk(2, "My Love"), mk(3, "Move Your Body")];
}

describe("clusterAlbums", () => {
  it("clusters two folders of the same album into one album with two versions", () => {
    const albums = clusterAlbums(scene());
    expect(albums).toHaveLength(1);
    const a = albums[0];
    expect(a.versions).toHaveLength(2);
    expect(new Set(a.versions.map((v) => v.key))).toEqual(
      new Set(["/lib/clean", "/lib/old"]),
    );
    expect(a.tracks).toHaveLength(3);
  });

  it("suggests keeping the cleaner (shorter-title) version when quality ties", () => {
    const a = clusterAlbums(scene())[0];
    expect(a.keepKey).toBe("/lib/clean");
  });

  it("prefers lossless over lossy for the keep suggestion", () => {
    const mk = (n: number) =>
      group([
        dfile(`/lib/lossy/${n}.mp3`, { lossless: false, codec: "mp3", album: "X" }),
        dfile(`/lib/lossless/${n}.flac`, { lossless: true, codec: "flac", album: "X" }),
      ]);
    const a = clusterAlbums([mk(1), mk(2)])[0];
    expect(a.keepKey).toBe("/lib/lossless");
  });

  it("does not form an album from a single shared track", () => {
    const one = group([
      dfile("/lib/a/x.flac", { album: "Y" }),
      dfile("/lib/b/x.aiff", { album: "Y" }),
    ]);
    expect(clusterAlbums([one])).toHaveLength(0);
  });
});

describe("deleteSetForAlbum", () => {
  it("returns the matched files of the non-kept versions", () => {
    const a = clusterAlbums(scene())[0];
    const del = deleteSetForAlbum(a, "/lib/clean");
    expect(del.sort()).toEqual([
      "/lib/old/1.aiff",
      "/lib/old/2.aiff",
      "/lib/old/3.aiff",
    ]);
  });
});

describe("trackGroupsOutsideAlbums", () => {
  it("returns groups not absorbed into any album", () => {
    const groups = scene();
    const loner = group([
      dfile("/lib/x/s.flac", { album: "Solo" }),
      dfile("/lib/y/s.mp3", { album: "Solo", lossless: false }),
    ]);
    const all = [...groups, loner];
    const albums = clusterAlbums(all);
    const left = trackGroupsOutsideAlbums(all, albums);
    expect(left).toEqual([loner]);
  });
});

describe("foldersToPrune", () => {
  it("prunes a folder with no remaining tracks, keeps one with a bonus track", () => {
    const deleted = ["/lib/old/1.aiff", "/lib/old/2.aiff", "/lib/old/3.aiff"];
    // No remaining tracks in /lib/old -> prune it.
    expect(foldersToPrune(deleted, ["/lib/clean/1.flac"])).toEqual(["/lib/old"]);
    // A bonus track remains in /lib/old -> keep it.
    expect(
      foldersToPrune(deleted, ["/lib/clean/1.flac", "/lib/old/bonus.aiff"]),
    ).toEqual([]);
  });
});
