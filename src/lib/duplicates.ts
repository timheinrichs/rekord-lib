import { Store } from "@tauri-apps/plugin-store";
import type { DuplicateGroup } from "../types";

// Gleiche Store-Datei wie Einstellungen/Library, eigener Schlüssel.
const STORE_FILE = "rekord-lib.json";
const KEY = "duplicates";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

/** Lädt die zuletzt gefundenen Duplikat-Gruppen (oder leer). */
export async function loadDuplicates(): Promise<DuplicateGroup[]> {
  const store = await getStore();
  const saved = await store.get<DuplicateGroup[]>(KEY);
  return saved ?? [];
}

/** Speichert die aktuellen Duplikat-Gruppen dauerhaft. */
export async function saveDuplicates(groups: DuplicateGroup[]): Promise<void> {
  const store = await getStore();
  await store.set(KEY, groups);
  await store.save();
}
