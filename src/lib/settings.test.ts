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

import {
  BPM_RANGE_PRESETS,
  DEFAULT_SETTINGS,
  bandcampFormatKey,
  bpmRangeLabel,
  loadSettings,
  saveSettings,
} from "./settings";

afterEach(() => {
  vi.clearAllMocks();
});

describe("bandcampFormatKey", () => {
  it("maps UI formats to Bandcamp download keys", () => {
    expect(bandcampFormatKey("aiff")).toBe("aiff-lossless");
    expect(bandcampFormatKey("aac")).toBe("aac-hi");
    expect(bandcampFormatKey("flac")).toBe("flac");
    expect(bandcampFormatKey("wav")).toBe("wav");
    expect(bandcampFormatKey("alac")).toBe("alac");
    expect(bandcampFormatKey("mp3-320")).toBe("mp3-320");
    expect(bandcampFormatKey("mp3-v0")).toBe("mp3-v0");
  });
});

describe("loadSettings", () => {
  it("returns defaults when nothing is stored", async () => {
    getMock.mockResolvedValueOnce(undefined);
    expect(await loadSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("defaults the download format to aiff", async () => {
    getMock.mockResolvedValueOnce(undefined);
    expect((await loadSettings()).download_format).toBe("aiff");
  });

  it("defaults Discogs credentials to null", async () => {
    getMock.mockResolvedValueOnce(undefined);
    const s = await loadSettings();
    expect(s.discogs_key).toBeNull();
    expect(s.discogs_secret).toBeNull();
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

describe("BPM_RANGE_PRESETS", () => {
  it("offers ranges that span exactly one octave, plus the wide default", () => {
    // The octave property is the whole reason these are presets and not two
    // free number fields: within one octave every tempo has one representative.
    const octaves = BPM_RANGE_PRESETS.filter((p) => p.max === p.min * 2);
    expect(octaves.length).toBe(BPM_RANGE_PRESETS.length - 1);
    const wide = BPM_RANGE_PRESETS.filter((p) => p.max !== p.min * 2);
    expect(wide).toEqual([{ min: 60, max: 200, label: "60–200 (wide)" }]);
  });

  it("keeps the default as today's behaviour", () => {
    // A narrower default would silently change what a scan produces on update.
    expect(DEFAULT_SETTINGS.bpm_min).toBe(60);
    expect(DEFAULT_SETTINGS.bpm_max).toBe(200);
    expect(
      BPM_RANGE_PRESETS.some(
        (p) => p.min === DEFAULT_SETTINGS.bpm_min && p.max === DEFAULT_SETTINGS.bpm_max,
      ),
    ).toBe(true);
  });

  it("has every range ordered and sane", () => {
    for (const p of BPM_RANGE_PRESETS) {
      expect(p.min).toBeGreaterThan(0);
      expect(p.max).toBeGreaterThan(p.min);
      expect(p.label).toContain(String(p.min));
    }
  });
});

describe("bpmRangeLabel", () => {
  it("names a known range", () => {
    expect(bpmRangeLabel(90, 180)).toBe("90–180 (one octave)");
    expect(bpmRangeLabel(60, 200)).toBe("60–200 (wide)");
  });

  it("still describes a range that matches no preset", () => {
    // A hand-edited store, or a preset list that has since changed.
    expect(bpmRangeLabel(75, 155)).toBe("75–155");
  });
});
