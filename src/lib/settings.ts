import { Store } from "@tauri-apps/plugin-store";
import type { TargetFormat } from "../types";

/** Format to request from Bandcamp when downloading. */
export type DownloadFormat =
  | "flac"
  | "wav"
  | "aiff"
  | "alac"
  | "mp3-320"
  | "mp3-v0"
  | "aac";

export const DOWNLOAD_FORMAT_LABELS: Record<DownloadFormat, string> = {
  flac: "FLAC (lossless)",
  wav: "WAV (lossless)",
  aiff: "AIFF (lossless)",
  alac: "ALAC (lossless)",
  "mp3-320": "MP3 320",
  "mp3-v0": "MP3 V0",
  aac: "AAC",
};

/** Maps a UI download format to the Bandcamp download key. */
export function bandcampFormatKey(f: DownloadFormat): string {
  switch (f) {
    case "aiff":
      return "aiff-lossless";
    case "aac":
      return "aac-hi";
    default:
      return f; // flac, wav, alac, mp3-320, mp3-v0 match the Bandcamp keys
  }
}

/**
 * Ranges offered for tempo detection.
 *
 * All but the last span exactly one octave (`max = 2 × min`), which is the point
 * of them: within one octave every tempo has a single representative, so the
 * octave decision has one answer instead of two. The wide range is 3.3:1 and
 * leaves 65 and 130 both in play — it stays the default because changing what a
 * scan produces on an update would be worse than leaving a suboptimal default.
 *
 * Measured against the reference set in `docs/DSP_BENCHMARK.md`.
 */
export const BPM_RANGE_PRESETS: { min: number; max: number; label: string }[] = [
  { min: 60, max: 200, label: "60–200 (wide)" },
  { min: 60, max: 120, label: "60–120 (one octave)" },
  { min: 70, max: 140, label: "70–140 (one octave)" },
  { min: 80, max: 160, label: "80–160 (one octave)" },
  { min: 90, max: 180, label: "90–180 (one octave)" },
  { min: 100, max: 200, label: "100–200 (one octave)" },
];

/**
 * The label for a stored range. A pair that matches no preset — from a hand
 * edited store, or a preset list that has since changed — is still described
 * rather than shown as nothing.
 */
export function bpmRangeLabel(min: number, max: number): string {
  const preset = BPM_RANGE_PRESETS.find((p) => p.min === min && p.max === max);
  return preset ? preset.label : `${min}–${max}`;
}

/** Default settings persisted in the app. */
export interface Settings {
  /** Central library folder (collection). */
  library_dir: string | null;
  /** Default target format for conversion. */
  format: TargetFormat;
  /** Default bit depth (16 or 24). */
  bit_depth: number;
  /** Clean up special characters in filenames. */
  sanitize_filenames: boolean;
  /** Format to request from Bandcamp downloads. */
  download_format: DownloadFormat;
  /**
   * Detect the BPM of tracks without one during the scan and write it into the
   * file's tag. Off means the scan stays read-only.
   */
  analyze_bpm: boolean;
  /**
   * Tempo range the detector searches, before octave correction.
   *
   * Stored as the two numbers rather than a preset name, so the value keeps
   * meaning something if the preset list ever changes.
   */
  bpm_min: number;
  bpm_max: number;
  /**
   * Library columns the user has switched off, by id. Empty means all of them —
   * the default is everything visible, and a column is hidden only on request.
   */
  hidden_columns: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  library_dir: null,
  format: "aiff",
  bit_depth: 16,
  sanitize_filenames: false,
  download_format: "aiff",
  analyze_bpm: true,
  // The historical range. Deliberately not one of the octave-wide presets: a
  // narrower default would silently move every user's results on update.
  bpm_min: 60,
  bpm_max: 200,
  hidden_columns: [],
};

// Same store file as the Rust backend (separate keys).
const STORE_FILE = "rekord-lib.json";
const SETTINGS_KEY = "settings";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

/** Loads the saved settings (filled in with defaults). */
export async function loadSettings(): Promise<Settings> {
  const store = await getStore();
  const saved = (await store.get<Partial<Settings>>(SETTINGS_KEY)) ?? {};
  // Only keys we still know. A value an older version wrote and this one has
  // dropped would otherwise ride along and be written back on every save —
  // which for the Discogs credentials, now in the Keychain, would mean the
  // plaintext copy coming back after the migration deleted it.
  const known = Object.fromEntries(
    // An own key, not `in`: `in` is true for `constructor` and `toString` too,
    // which would let a stored key of that name ride through.
    Object.entries(saved).filter(([k]) =>
      Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, k),
    ),
  ) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...known };
}

/** Persists the settings. */
export async function saveSettings(settings: Settings): Promise<void> {
  const store = await getStore();
  await store.set(SETTINGS_KEY, settings);
  await store.save();
}
