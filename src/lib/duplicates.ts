import { Store } from "@tauri-apps/plugin-store";
import type { DuplicateGroup } from "../types";

// Same store file as settings/library, with its own key.
const STORE_FILE = "rekord-lib.json";
const KEY = "duplicates";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

/** Loads the most recently found duplicate groups (or empty). */
export async function loadDuplicates(): Promise<DuplicateGroup[]> {
  const store = await getStore();
  const saved = await store.get<DuplicateGroup[]>(KEY);
  return saved ?? [];
}

/** Persists the current duplicate groups. */
export async function saveDuplicates(groups: DuplicateGroup[]): Promise<void> {
  const store = await getStore();
  await store.set(KEY, groups);
  await store.save();
}
