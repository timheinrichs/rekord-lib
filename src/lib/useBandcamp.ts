import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  bandcampCollection,
  bandcampDownload,
  cancelBandcampDownload,
  onBandcampProgress,
} from "./api";
import {
  loadBandcampCollection,
  saveBandcampCollection,
} from "./bandcampCache";
import { syncCollection } from "./bandcampSync";
import { bandcampFormatKey, type Settings } from "./settings";
import type {
  BandcampAccount,
  BandcampItem,
  BandcampProgress,
  TrackAnalysis,
} from "../types";

/** State of a single Bandcamp download (for the downloads overlay). */
export interface DownloadEntry {
  key: string;
  title: string;
  band: string;
  state: "loading" | "done" | "error";
  downloaded: number;
  total: number;
  stage: string;
  error?: string;
}

/** Progress of a bulk operation ("download all" / "sync"). */
export interface BulkProgress {
  kind: "all" | "sync";
  done: number;
  total: number;
}

export interface UseBandcamp {
  collection: BandcampItem[];
  downloads: Record<string, DownloadEntry>;
  refreshing: boolean;
  bulk: BulkProgress | null;
  error: string | null;
  refresh: () => Promise<void>;
  downloadItem: (item: BandcampItem) => Promise<void>;
  downloadAll: () => Promise<void>;
  syncLibrary: (tracks: TrackAnalysis[]) => Promise<void>;
  cancelDownload: (key: string) => void;
  clearFinished: () => void;
}

/**
 * Owns the Bandcamp collection (cached + refreshed), the downloads queue and
 * their progress. Lifted out of LibraryView so the collection page and the
 * downloads overlay are available app-wide.
 */
export function useBandcamp(
  settings: Settings,
  account: BandcampAccount | null,
): UseBandcamp {
  const [collection, setCollection] = useState<BandcampItem[]>([]);
  const [downloads, setDownloads] = useState<Record<string, DownloadEntry>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [bulk, setBulk] = useState<BulkProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Latest settings/collection for stable callbacks.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const collectionRef = useRef(collection);
  collectionRef.current = collection;

  // Byte progress from the backend into the matching download entry.
  useEffect(() => {
    let un: (() => void) | undefined;
    void (async () => {
      un = await onBandcampProgress((p: BandcampProgress) => {
        setDownloads((prev) => {
          const entry = prev[p.key];
          if (!entry) return prev;
          return {
            ...prev,
            [p.key]: {
              ...entry,
              downloaded: p.downloaded,
              total: p.total,
              stage: p.stage,
            },
          };
        });
      });
    })();
    return () => un?.();
  }, []);

  // Show the cached collection immediately on start.
  useEffect(() => {
    void loadBandcampCollection().then((c) => {
      if (c.length) setCollection(c);
    });
  }, []);

  const refresh = useCallback(async () => {
    if (!account) return;
    setRefreshing(true);
    setError(null);
    try {
      const items = await bandcampCollection();
      setCollection(items);
      void saveBandcampCollection(items);
    } catch (e) {
      setError(`Bandcamp: ${e}`);
    } finally {
      setRefreshing(false);
    }
  }, [account]);

  // Refresh in the background whenever an account is connected.
  useEffect(() => {
    if (account) void refresh();
  }, [account, refresh]);

  // Downloads a single item without triggering a rescan (used by bulk too).
  const runDownload = useCallback(async (item: BandcampItem): Promise<boolean> => {
    const dir = settingsRef.current.library_dir;
    if (!item.download_page_url || !dir) return false;
    setDownloads((s) => ({
      ...s,
      [item.key]: {
        key: item.key,
        title: item.title,
        band: item.band_name,
        state: "loading",
        downloaded: 0,
        total: 0,
        stage: "Downloading",
      },
    }));
    const finish = (patch: Partial<DownloadEntry>) =>
      setDownloads((s) =>
        s[item.key] ? { ...s, [item.key]: { ...s[item.key], ...patch } } : s,
      );
    try {
      const res = await bandcampDownload(
        item.key,
        item.download_page_url,
        dir,
        bandcampFormatKey(settingsRef.current.download_format),
      );
      if (res.success) {
        finish({ state: "done", stage: "Done" });
        return true;
      }
      finish({ state: "error", error: res.error ?? "Download failed" });
      return false;
    } catch (e) {
      finish({ state: "error", error: String(e) });
      return false;
    }
  }, []);

  // No explicit rescan here: the library folder watcher picks up new files
  // incrementally once a download finishes.
  const downloadItem = useCallback(
    async (item: BandcampItem) => {
      await runDownload(item);
    },
    [runDownload],
  );

  const runQueue = useCallback(
    async (items: BandcampItem[], kind: "all" | "sync") => {
      const queue = items.filter((i) => i.download_page_url);
      if (!queue.length || !settingsRef.current.library_dir) return;
      setBulk({ kind, done: 0, total: queue.length });
      for (let i = 0; i < queue.length; i++) {
        await runDownload(queue[i]);
        setBulk({ kind, done: i + 1, total: queue.length });
      }
      setBulk(null);
    },
    [runDownload],
  );

  const downloadAll = useCallback(
    () => runQueue(collectionRef.current, "all"),
    [runQueue],
  );

  const syncLibrary = useCallback(
    (tracks: TrackAnalysis[]) => {
      const { missing } = syncCollection(tracks, collectionRef.current);
      return runQueue(missing, "sync");
    },
    [runQueue],
  );

  // Cancel an in-flight download: tell the backend to abort and drop the entry.
  const cancelDownload = useCallback((key: string) => {
    void cancelBandcampDownload(key);
    setDownloads((s) => {
      if (!s[key]) return s;
      const next = { ...s };
      delete next[key];
      return next;
    });
  }, []);

  const clearFinished = useCallback(() => {
    setDownloads((s) =>
      Object.fromEntries(
        Object.entries(s).filter(([, d]) => d.state === "loading"),
      ),
    );
  }, []);

  return useMemo(
    () => ({
      collection,
      downloads,
      refreshing,
      bulk,
      error,
      refresh,
      downloadItem,
      downloadAll,
      syncLibrary,
      cancelDownload,
      clearFinished,
    }),
    [
      collection,
      downloads,
      refreshing,
      bulk,
      error,
      refresh,
      downloadItem,
      downloadAll,
      syncLibrary,
      cancelDownload,
      clearFinished,
    ],
  );
}
