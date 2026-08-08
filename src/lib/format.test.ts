import { describe, expect, it } from "vitest";
import {
  editComplete,
  formatBytes,
  formatDate,
  formatDuration,
  formatLabel,
  formatSampleRate,
  trackStatus,
} from "./format";
import { makeCompat, makeMetadata, makeTrack } from "../test/factories";
import type { TrackEdit } from "../types";

describe("editComplete", () => {
  const cover = { kind: "keep" as const };

  it("is true when all required text fields are set", () => {
    const edit: TrackEdit = { metadata: makeMetadata(), cover };
    expect(editComplete(edit)).toBe(true);
  });

  it("ignores optional catalog number, label, genre and year", () => {
    const edit: TrackEdit = {
      metadata: makeMetadata({
        catalog_number: null,
        label: null,
        genre: null,
        year: null,
      }),
      cover,
    };
    expect(editComplete(edit)).toBe(true);
  });

  it("is false when a required field is missing or blank", () => {
    expect(
      editComplete({ metadata: makeMetadata({ album: null }), cover }),
    ).toBe(false);
    expect(
      editComplete({ metadata: makeMetadata({ album_artist: "  " }), cover }),
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

describe("formatDate", () => {
  it("formats millis as YYYY-MM-DD and handles null", () => {
    const ms = new Date(2026, 6, 21).getTime(); // 2026-07-21 local
    expect(formatDate(ms)).toBe("2026-07-21");
    expect(formatDate(null)).toBe("–");
    expect(formatDate(0)).toBe("–");
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

describe("trackStatus", () => {
  const kinds = (...args: Parameters<typeof trackStatus>) =>
    trackStatus(...args).map((s) => s.kind);

  it("reports nothing for a compatible, fully tagged file", () => {
    expect(kinds(makeTrack())).toEqual([]);
  });

  it("marks incomplete metadata but never 'compatible'", () => {
    expect(kinds(makeTrack({ metadata_incomplete: true }))).toEqual([
      "incomplete",
    ]);
  });

  it("marks conversion need and keeps the issues in the tooltip", () => {
    const track = makeTrack({
      compat: makeCompat({
        compatible: false,
        issues: [{ code: "SAMPLE_RATE", message: "bad rate", severity: "error" }],
      }),
    });
    const convert = trackStatus(track).find((s) => s.kind === "convert");
    expect(convert).toBeDefined();
    expect(convert?.title).toContain("bad rate");
  });

  it("notes warnings on files that are otherwise compatible", () => {
    const track = makeTrack({
      compat: makeCompat({
        compatible: true,
        issues: [{ code: "LOUD", message: "very loud", severity: "warning" }],
      }),
    });
    const note = trackStatus(track).find((s) => s.kind === "note");
    expect(note?.title).toBe("very loud");
  });

  it("turns incomplete into complete once an edit fills the gaps", () => {
    const track = makeTrack({ metadata_incomplete: true });
    const edit: TrackEdit = { metadata: makeMetadata(), cover: { kind: "keep" } };
    expect(kinds(track, edit, true)).toEqual(["complete", "bandcamp"]);
  });

  it("keeps incomplete when the edit is still missing fields", () => {
    const track = makeTrack({ metadata_incomplete: true });
    const edit: TrackEdit = {
      metadata: makeMetadata({ album_artist: null }),
      cover: { kind: "keep" },
    };
    expect(kinds(track, edit)).toEqual(["incomplete"]);
  });
});
