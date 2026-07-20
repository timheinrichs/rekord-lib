import { Store } from "@tauri-apps/plugin-store";
import type { TrackAnalysis, TrackEdit } from "../types";

/** Persisted state of the track database (per library folder). */
export interface LibraryCache {
  library_dir: string | null;
  tracks: TrackAnalysis[];
  edits: Record<string, TrackEdit>;
}

// Same store file as settings/backend, with its own key.
const STORE_FILE = "rekord-lib.json";
const LIBRARY_KEY = "library";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

/** Loads the cached track database (or null). */
export async function loadLibrary(): Promise<LibraryCache | null> {
  const store = await getStore();
  const saved = await store.get<LibraryCache>(LIBRARY_KEY);
  return saved ?? null;
}

/** Persists the track database. */
export async function saveLibrary(cache: LibraryCache): Promise<void> {
  const store = await getStore();
  await store.set(LIBRARY_KEY, cache);
  await store.save();
}
