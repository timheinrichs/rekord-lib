import { Store } from "@tauri-apps/plugin-store";
import type { TargetFormat } from "../types";

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
}

export const DEFAULT_SETTINGS: Settings = {
  library_dir: null,
  format: "aiff",
  bit_depth: 16,
  sanitize_filenames: false,
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
