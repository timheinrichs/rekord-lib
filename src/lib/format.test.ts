import { describe, expect, it } from "vitest";
import {
  editComplete,
  formatBytes,
  formatDuration,
  formatLabel,
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

  it("ignores optional catalog number, label and genre", () => {
    const edit: TrackEdit = {
      metadata: makeMetadata({ catalog_number: null, label: null, genre: null }),
      cover,
    };
    expect(editComplete(edit)).toBe(true);
  });

  it("is false when a required field is missing or blank", () => {
    expect(
      editComplete({ metadata: makeMetadata({ album: null }), cover }),
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

describe("formatLabel", () => {
  it("renders raw PCM as its container with bit depth", () => {
    expect(formatLabel("pcm_s16be", "aiff", 16)).toBe("AIFF 16-bit");
    expect(formatLabel("pcm_s24be", "aiff", 24)).toBe("AIFF 24-bit");
    expect(formatLabel("pcm_s16le", "wav", 16)).toBe("WAV 16-bit");
  });

  it("labels lossless + lossy codecs", () => {
    expect(formatLabel("flac", "flac", 24)).toBe("FLAC 24-bit");
    expect(formatLabel("alac", "mov,mp4,m4a", 16)).toBe("ALAC 16-bit");
    expect(formatLabel("mp3", "mp3", 0)).toBe("MP3");
    expect(formatLabel("aac", "mov,mp4,m4a", 0)).toBe("AAC");
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
  it("shows no Compatible badge for compatible files, only metadata state", () => {
    const track = makeTrack({ metadata_incomplete: true });
    const labels = trackBadges(track).map((b) => b.label);
    expect(labels).not.toContain("Compatible");
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
