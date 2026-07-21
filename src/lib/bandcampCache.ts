import { Store } from "@tauri-apps/plugin-store";
import type { BandcampItem } from "../types";

// Same store file as settings/library, with its own key.
const STORE_FILE = "rekord-lib.json";
const KEY = "bandcamp_collection";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

/** Loads the cached Bandcamp collection (or empty). */
export async function loadBandcampCollection(): Promise<BandcampItem[]> {
  const store = await getStore();
  const saved = await store.get<BandcampItem[]>(KEY);
  return saved ?? [];
}

/** Persists the Bandcamp collection so it shows instantly on next start. */
export async function saveBandcampCollection(
  items: BandcampItem[],
): Promise<void> {
  const store = await getStore();
  await store.set(KEY, items);
  await store.save();
}
