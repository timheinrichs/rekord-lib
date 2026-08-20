import { afterEach, describe, expect, it, vi } from "vitest";

const { checkMock, relaunchMock } = vi.hoisted(() => ({
  checkMock: vi.fn(),
  relaunchMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: checkMock }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: relaunchMock }));

import { checkForUpdate, installUpdate } from "./updater";

afterEach(() => vi.clearAllMocks());

describe("checkForUpdate", () => {
  it("maps an available update", async () => {
    checkMock.mockResolvedValueOnce({
      version: "1.2.0",
      currentVersion: "1.1.0",
      body: "release notes",
      downloadAndInstall: vi.fn(),
    });
    expect(await checkForUpdate()).toEqual({
      version: "1.2.0",
      currentVersion: "1.1.0",
      notes: "release notes",
      severity: null,
    });
  });

  it("reads the severity the release marked itself with", async () => {
    // The notes are the changelog section for this version, so the marker
    // travels with the text people read before installing.
    checkMock.mockResolvedValueOnce({
      version: "1.2.0",
      currentVersion: "1.1.0",
      body: "**Severity:** critical\n\n### Fixed\n- A data-loss bug.",
      downloadAndInstall: vi.fn(),
    });
    const update = await checkForUpdate();
    expect(update?.severity).toBe("critical");
  });

  it("has no severity when there are no notes at all", async () => {
    // Which is every release built before the workflow started passing them.
    checkMock.mockResolvedValueOnce({
      version: "1.2.0",
      currentVersion: "1.1.0",
      body: "",
      downloadAndInstall: vi.fn(),
    });
    const update = await checkForUpdate();
    expect(update?.notes).toBeUndefined();
    expect(update?.severity).toBeNull();
  });

  it("returns null when up to date", async () => {
    checkMock.mockResolvedValueOnce(null);
    expect(await checkForUpdate()).toBeNull();
  });

  it("treats errors (no endpoint / offline / dev) as up to date", async () => {
    checkMock.mockRejectedValueOnce(new Error("no endpoint"));
    expect(await checkForUpdate()).toBeNull();
  });
});

describe("installUpdate", () => {
  it("downloads with progress, installs and relaunches", async () => {
    const downloadAndInstall = vi.fn(
      async (cb: (e: Record<string, unknown>) => void) => {
        cb({ event: "Started", data: { contentLength: 100 } });
        cb({ event: "Progress", data: { chunkLength: 40 } });
        cb({ event: "Progress", data: { chunkLength: 60 } });
        cb({ event: "Finished" });
      },
    );
    checkMock.mockResolvedValueOnce({
      version: "2.0.0",
      currentVersion: "1.0.0",
      body: "",
      downloadAndInstall,
    });
    await checkForUpdate(); // caches the pending update

    const progress: Array<[number, number | null]> = [];
    await installUpdate((d, t) => progress.push([d, t]));

    expect(downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunchMock).toHaveBeenCalledTimes(1);
    expect(progress[progress.length - 1]).toEqual([100, 100]);
  });

  it("throws when no update is pending", async () => {
    checkMock.mockResolvedValueOnce(null);
    await checkForUpdate(); // clears the pending update
    await expect(installUpdate()).rejects.toThrow();
    expect(relaunchMock).not.toHaveBeenCalled();
  });
});
