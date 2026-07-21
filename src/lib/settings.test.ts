import { afterEach, describe, expect, it, vi } from "vitest";

const { getMock, setMock, saveMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  setMock: vi.fn(),
  saveMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  Store: {
    load: vi.fn(async () => ({ get: getMock, set: setMock, save: saveMock })),
  },
}));

import { DEFAULT_SETTINGS, loadSettings, saveSettings } from "./settings";

afterEach(() => {
  vi.clearAllMocks();
});

describe("loadSettings", () => {
  it("returns defaults when nothing is stored", async () => {
    getMock.mockResolvedValueOnce(undefined);
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("merges stored values over the defaults", async () => {
    getMock.mockResolvedValueOnce({ format: "flac", bit_depth: 24 });
    const s = await loadSettings();
    expect(s.format).toBe("flac");
    expect(s.bit_depth).toBe(24);
    // untouched keys keep their defaults
    expect(s.library_dir).toBe(DEFAULT_SETTINGS.library_dir);
    expect(s.sanitize_filenames).toBe(DEFAULT_SETTINGS.sanitize_filenames);
  });
});

describe("saveSettings", () => {
  it("persists via the store and calls save", async () => {
    await saveSettings({ ...DEFAULT_SETTINGS, format: "wav" });
    expect(setMock).toHaveBeenCalledWith(
      "settings",
      expect.objectContaining({ format: "wav" }),
    );
    expect(saveMock).toHaveBeenCalled();
  });
});
