import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  clearEdits,
  forgetTracks,
  isLibraryDirAvailable,
  loadEdits,
  loadLibraryTracks,
  relocateLibrary,
  saveEdit,
} from "./library";
import { makeTrack } from "../test/factories";
import type { TrackEdit } from "../types";

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadLibraryTracks", () => {
  it("asks the backend for one folder's tracks", async () => {
    const track = makeTrack({ id: "/lib/a.aiff", path: "/lib/a.aiff" });
    invokeMock.mockResolvedValue([track]);

    await expect(loadLibraryTracks("/lib")).resolves.toEqual([track]);
    expect(invokeMock).toHaveBeenCalledWith("library_load", { dir: "/lib" });
  });
});

describe("forgetTracks", () => {
  it("passes the paths through and returns how many rows went", async () => {
    invokeMock.mockResolvedValue(2);
    await expect(forgetTracks(["/lib/a.aiff", "/lib/b.aiff"])).resolves.toBe(2);
    expect(invokeMock).toHaveBeenCalledWith("library_delete", {
      paths: ["/lib/a.aiff", "/lib/b.aiff"],
    });
  });
});

describe("isLibraryDirAvailable", () => {
  it("asks the backend whether the folder can be listed", async () => {
    invokeMock.mockResolvedValue(false);
    await expect(isLibraryDirAvailable("/gone")).resolves.toBe(false);
    expect(invokeMock).toHaveBeenCalledWith("library_dir_available", {
      dir: "/gone",
    });
  });
});

describe("relocateLibrary", () => {
  it("passes both roots and returns what moved", async () => {
    invokeMock.mockResolvedValue({ moved: 3, skipped: 1 });
    await expect(relocateLibrary("/old", "/new")).resolves.toEqual({
      moved: 3,
      skipped: 1,
    });
    expect(invokeMock).toHaveBeenCalledWith("library_relocate", {
      oldDir: "/old",
      newDir: "/new",
    });
  });
});

describe("edits", () => {
  const edit: TrackEdit = {
    metadata: { ...makeTrack().metadata, title: "New" },
    cover: { kind: "keep" },
  };

  it("loads the whole map", async () => {
    invokeMock.mockResolvedValue({ "/lib/a.aiff": edit });
    await expect(loadEdits()).resolves.toEqual({ "/lib/a.aiff": edit });
    expect(invokeMock).toHaveBeenCalledWith("edits_load");
  });

  it("writes a single edit rather than the whole library", async () => {
    invokeMock.mockResolvedValue(undefined);
    await saveEdit("/lib/a.aiff", edit);
    expect(invokeMock).toHaveBeenCalledWith("edit_set", {
      path: "/lib/a.aiff",
      edit,
    });
  });

  it("clears the given paths", async () => {
    invokeMock.mockResolvedValue(undefined);
    await clearEdits(["/lib/a.aiff"]);
    expect(invokeMock).toHaveBeenCalledWith("edit_clear", {
      paths: ["/lib/a.aiff"],
    });
  });

  it("does not call the backend for an empty clear", async () => {
    // Written edits and undo both funnel through here, often with nothing to
    // do — a round trip per no-op would be pure noise.
    await clearEdits([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
