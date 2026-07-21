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
  /** Discogs app credentials for metadata suggestions (stored locally only). */
  discogs_key: string | null;
  discogs_secret: string | null;
}

export const DEFAULT_SETTINGS: Settings = {
  library_dir: null,
  format: "aiff",
  bit_depth: 16,
  sanitize_filenames: false,
  download_format: "aiff",
  discogs_key: null,
  discogs_secret: null,
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
  const saved = await store.get<Partial<Settings>>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}

/** Persists the settings. */
export async function saveSettings(settings: Settings): Promise<void> {
  const store = await getStore();
  await store.set(SETTINGS_KEY, settings);
  await store.save();
}
