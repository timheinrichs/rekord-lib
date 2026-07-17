import { Store } from "@tauri-apps/plugin-store";
import type { TargetFormat } from "../types";

/** In der App persistierte Standard-Einstellungen. */
export interface Settings {
  /** Zentraler Library-Ordner (Sammlung). */
  library_dir: string | null;
  /** Standard-Zielformat der Konvertierung. */
  format: TargetFormat;
  /** Standard-Bit-Tiefe (16 oder 24). */
  bit_depth: number;
  /** Sonderzeichen in Dateinamen bereinigen. */
  sanitize_filenames: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  library_dir: null,
  format: "aiff",
  bit_depth: 16,
  sanitize_filenames: false,
};

// Gleiche Store-Datei wie das Rust-Backend (getrennte Schlüssel).
const STORE_FILE = "rekord-lib.json";
const SETTINGS_KEY = "settings";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

/** Lädt die gespeicherten Einstellungen (mit Defaults aufgefüllt). */
export async function loadSettings(): Promise<Settings> {
  const store = await getStore();
  const saved = await store.get<Partial<Settings>>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}

/** Speichert die Einstellungen dauerhaft. */
export async function saveSettings(settings: Settings): Promise<void> {
  const store = await getStore();
  await store.set(SETTINGS_KEY, settings);
  await store.save();
}
