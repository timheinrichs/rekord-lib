import { afterEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { dismissDuplicates, loadDuplicates, saveDuplicates } from "./duplicates";
import type { DuplicateGroup } from "../types";

afterEach(() => {
  vi.clearAllMocks();
});

const group: DuplicateGroup = {
  id: "/lib/a.aiff",
  files: [],
  keep_id: "/lib/a.aiff",
};

describe("duplicates store", () => {
  it("loads the stored groups", async () => {
    invokeMock.mockResolvedValue([group]);
    await expect(loadDuplicates()).resolves.toEqual([group]);
    expect(invokeMock).toHaveBeenCalledWith("duplicates_load");
  });

  it("saves the groups it is given", async () => {
    invokeMock.mockResolvedValue(undefined);
    await saveDuplicates([group]);
    expect(invokeMock).toHaveBeenCalledWith("duplicates_save", {
      groups: [group],
    });
  });

  it("saves an empty result too (that is how the cache is cleared)", async () => {
    invokeMock.mockResolvedValue(undefined);
    await saveDuplicates([]);
    expect(invokeMock).toHaveBeenCalledWith("duplicates_save", { groups: [] });
  });
});

describe("dismissDuplicates", () => {
  it("records the dismissal by group id", async () => {
    invokeMock.mockResolvedValue(undefined);
    await dismissDuplicates("/lib/a.aiff");
    expect(invokeMock).toHaveBeenCalledWith("duplicates_dismiss", {
      id: "/lib/a.aiff",
    });
  });
});
