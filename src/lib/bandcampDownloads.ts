import { Store } from "@tauri-apps/plugin-store";

/** Bandcamp item key -> the audio file paths that download wrote. */
export type DownloadLedger = Record<string, string[]>;

// Same store file as the collection cache, with its own key.
const STORE_FILE = "rekord-lib.json";
const KEY = "bandcamp_downloads";

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

/** Loads the download ledger (item key -> written files), or empty. */
export async function loadDownloadLedger(): Promise<DownloadLedger> {
  const store = await getStore();
  const saved = await store.get<DownloadLedger>(KEY);
  return saved ?? {};
}

/** Persists the download ledger. */
export async function saveDownloadLedger(ledger: DownloadLedger): Promise<void> {
  const store = await getStore();
  await store.set(KEY, ledger);
  await store.save();
}

/**
 * Removes deleted file paths from the ledger and drops entries left empty, so a
 * purchase whose files were trashed is offered by sync again. Pure;
 * reference-stable when nothing matched.
 */
export function pruneLedger(
  ledger: DownloadLedger,
  deletedPaths: string[],
): DownloadLedger {
  const gone = new Set(deletedPaths);
  let changed = false;
  const next: DownloadLedger = {};
  for (const [key, paths] of Object.entries(ledger)) {
    const kept = paths.filter((p) => !gone.has(p));
    if (kept.length !== paths.length) changed = true;
    if (kept.length) next[key] = kept;
  }
  return changed ? next : ledger;
}
