import { describe, expect, it } from "vitest";
import {
  editComplete,
  formatBytes,
  formatDuration,
  formatSampleRate,
  trackBadges,
} from "./format";
import { makeCompat, makeMetadata, makeTrack } from "../test/factories";
import type { TrackEdit } from "../types";

describe("editComplete", () => {
  const cover = { kind: "keep" as const };

  it("is true when all required text fields are set", () => {
    const edit: TrackEdit = { metadata: makeMetadata(), cover };
    expect(editComplete(edit)).toBe(true);
  });

  it("ignores optional catalog number and label", () => {
    const edit: TrackEdit = {
      metadata: makeMetadata({ catalog_number: null, label: null }),
      cover,
    };
    expect(editComplete(edit)).toBe(true);
  });

  it("is false when a required field is missing or blank", () => {
    expect(
      editComplete({ metadata: makeMetadata({ genre: null }), cover }),
    ).toBe(false);
    expect(
      editComplete({ metadata: makeMetadata({ year: "  " }), cover }),
    ).toBe(false);
  });
});

describe("formatDuration", () => {
  it("formats mm:ss with zero padding", () => {
    expect(formatDuration(0)).toBe("–");
    expect(formatDuration(5)).toBe("0:05");
    expect(formatDuration(65)).toBe("1:05");
    expect(formatDuration(600)).toBe("10:00");
  });

  it("returns dash for invalid input", () => {
    expect(formatDuration(-1)).toBe("–");
  });
});

describe("formatSampleRate", () => {
  it("formats kHz with one decimal", () => {
    expect(formatSampleRate(44_100)).toBe("44.1 kHz");
    expect(formatSampleRate(48_000)).toBe("48.0 kHz");
    expect(formatSampleRate(0)).toBe("–");
  });
});

describe("formatBytes", () => {
  it("scales units", () => {
    expect(formatBytes(0)).toBe("–");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(5 * 1024 * 1024 * 1024)).toBe("5.0 GB");
  });
});

describe("trackBadges", () => {
  it("shows Compatible + Metadata incomplete based on scan state", () => {
    const track = makeTrack({ metadata_incomplete: true });
    const badges = trackBadges(track);
    const labels = badges.map((b) => b.label);
    expect(labels).toContain("Compatible");
    expect(labels).toContain("Metadata incomplete");
  });

  it("shows Convert for incompatible files with issue tooltip", () => {
    const track = makeTrack({
      compat: makeCompat({
        compatible: false,
        issues: [{ code: "SAMPLE_RATE", message: "bad rate", severity: "error" }],
      }),
    });
    const convert = trackBadges(track).find((b) => b.label === "Convert");
    expect(convert).toBeDefined();
    expect(convert?.title).toContain("bad rate");
  });

  it("adds Metadata ✓ once a complete edit exists, plus Bandcamp origin", () => {
    const track = makeTrack({ metadata_incomplete: true });
    const edit: TrackEdit = { metadata: makeMetadata(), cover: { kind: "keep" } };
    const labels = trackBadges(track, edit, true).map((b) => b.label);
    expect(labels).toContain("Metadata ✓");
    expect(labels).toContain("Bandcamp");
    expect(labels).not.toContain("Metadata incomplete");
  });
});
