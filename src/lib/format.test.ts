import { describe, expect, it } from "vitest";
import {
  UNCERTAIN_BPM_CONFIDENCE,
  bpmIsUncertain,
  editComplete,
  formatBpm,
  formatKey,
  keyConfidenceLabel,
  parseBpmInput,
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

describe("formatBpm", () => {
  it("shows whole beats", () => {
    // What a DJ reads, and what other DJ software shows. The decimals stay in
    // the file and the library; this is display only.
    expect(formatBpm(128)).toBe("128");
    expect(formatBpm(127.61)).toBe("128");
    expect(formatBpm(127.4)).toBe("127");
    expect(formatBpm(128)).not.toContain(".");
  });

  it("hides the artefacts of a widened f32", () => {
    // The detector works in f32; 127.6 widened to f64 is this.
    expect(formatBpm(127.5999984741211)).toBe("128");
    expect(formatBpm(89.99999237060547)).toBe("90");
  });

  it("shows a dash rather than a number for nothing", () => {
    expect(formatBpm(null)).toBe("–");
    expect(formatBpm(undefined)).toBe("–");
    expect(formatBpm(NaN)).toBe("–");
    expect(formatBpm(Infinity)).toBe("–");
  });
});

describe("bpmIsUncertain", () => {
  it("is false where the tempo came from the tag", () => {
    // No confidence means nobody detected it — that is not "uncertain".
    expect(bpmIsUncertain(null)).toBe(false);
    expect(bpmIsUncertain(undefined)).toBe(false);
  });

  it("marks exactly what the backend refused to write", () => {
    // The threshold has to agree with MIN_WRITE_CONFIDENCE in commands.rs, or
    // the app shows a value as trustworthy that is not in the file.
    expect(bpmIsUncertain(UNCERTAIN_BPM_CONFIDENCE - 0.01)).toBe(true);
    expect(bpmIsUncertain(UNCERTAIN_BPM_CONFIDENCE)).toBe(false);
    expect(bpmIsUncertain(0)).toBe(true);
    expect(bpmIsUncertain(1)).toBe(false);
  });
});

describe("parseBpmInput", () => {
  it("accepts a comma as the decimal separator", () => {
    // A German keyboard produces this, and so do plenty of taggers.
    expect(parseBpmInput("127,6")).toBe(127.6);
    expect(parseBpmInput("127.6")).toBe(127.6);
  });

  it("takes whole numbers and stray whitespace", () => {
    expect(parseBpmInput("128")).toBe(128);
    expect(parseBpmInput("  174 ")).toBe(174);
  });

  it("clears the field for anything unusable", () => {
    expect(parseBpmInput("")).toBeNull();
    expect(parseBpmInput("   ")).toBeNull();
    expect(parseBpmInput("fast")).toBeNull();
    // Zero and negatives are not tempos; they used to slip through as numbers.
    expect(parseBpmInput("0")).toBeNull();
    expect(parseBpmInput("-128")).toBeNull();
  });
});

describe("formatKey", () => {
  it("shows the name and the Camelot position", () => {
    // Two spellings because they answer different questions: the name says what
    // the track is, the number says what it mixes with.
    expect(formatKey("Am", "8A")).toBe("Am · 8A");
    expect(formatKey("F#m", "11A")).toBe("F#m · 11A");
  });

  it("falls back to the name alone", () => {
    // Camelot is derived on read; a row from an older database may not have it.
    expect(formatKey("Am", null)).toBe("Am");
  });

  it("shows a dash rather than an empty cell", () => {
    expect(formatKey(null, null)).toBe("–");
    expect(formatKey(null, "8A")).toBe("–");
    expect(formatKey(undefined, undefined)).toBe("–");
  });
});

describe("keyConfidenceLabel", () => {
  it("reports the percentage as measured", () => {
    // A number rather than a threshold: agreement with Rekordbox climbs from
    // 32 % to 71 % across the confidence range, and no cut-off is both accurate
    // and covers much of a collection.
    expect(keyConfidenceLabel(0.45)).toBe("45% sure");
    expect(keyConfidenceLabel(0.08)).toBe("8% sure");
    expect(keyConfidenceLabel(1)).toBe("100% sure");
  });

  it("says nothing where there is nothing to say", () => {
    expect(keyConfidenceLabel(null)).toBeNull();
    expect(keyConfidenceLabel(undefined)).toBeNull();
    expect(keyConfidenceLabel(NaN)).toBeNull();
  });
});
