import { Store } from "@tauri-apps/plugin-store";
import type { TrackAnalysis, TrackEdit } from "../types";

/** Persistierter Zustand der Track-Datenbank (pro Library-Ordner). */
export interface LibraryCache {
  library_dir: string | null;
  tracks: TrackAnalysis[];
  edits: Record<string, TrackEdit>;
}

// Gleiche Store-Datei wie Einstellungen/Backend, eigener Schlüssel.
const STORE_FILE = "rekord-lib.json";
const LIBRARY_KEY = "library";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

/** Lädt die zwischengespeicherte Track-Datenbank (oder null). */
export async function loadLibrary(): Promise<LibraryCache | null> {
  const store = await getStore();
  const saved = await store.get<LibraryCache>(LIBRARY_KEY);
  return saved ?? null;
}

/** Speichert die Track-Datenbank dauerhaft. */
export async function saveLibrary(cache: LibraryCache): Promise<void> {
  const store = await getStore();
  await store.set(LIBRARY_KEY, cache);
  await store.save();
}
