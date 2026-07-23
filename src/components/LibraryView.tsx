import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  analyzeFiles,
  convertTracks,
  dedupeStatus,
  deleteAlbum,
  deleteFiles,
  listAudioFiles,
  onConvertProgress,
  onDedupeDone,
  onDedupeProgress,
  onLibraryChanged,
  onScanDone,
  onScanProgress,
  pruneEmptyDirs,
  scanStatus,
  startDedupe,
  startLibraryWatch,
  startScan,
  writeMetadata,
  type WriteMetadataItem,
} from "../lib/api";
import { loadLibrary, saveLibrary } from "../lib/library";
import { loadDuplicates, saveDuplicates } from "../lib/duplicates";
import {
  editComplete,
  formatDate,
  formatDuration,
  formatLabel,
  formatSampleRate,
  trackBadges,
} from "../lib/format";
import type { Settings } from "../lib/settings";
import type {
  ConvertJob,
  ConvertOptions,
  ConvertProgress,
  ConvertResult,
  DeleteResult,
  DuplicateGroup,
  TrackAnalysis,
  TrackEdit,
} from "../types";
import MetadataEditor from "./MetadataEditor";
import BulkMetadataEditor, { type BulkPatch } from "./BulkMetadataEditor";
import CoverThumb from "./CoverThumb";
import { usePlayer, type PlayerTrack } from "../lib/player";
import MarqueeText from "./MarqueeText";
import DuplicatesModal from "./DuplicatesModal";
import AppHeader from "./AppHeader";
import {
  ArrowUpIcon,
  ChevronIcon,
  EditIcon,
  SpinnerIcon,
  TrashIcon,
  UndoIcon,
} from "./icons";
import { useScrolled } from "../lib/useScrolled";
import {
  albumArtistOf,
  buildAlbumItems,
  pruneGroups,
  sortTracks,
  type AlbumItem,
  type SortKey,
} from "../lib/grouping";
import { foldersToPrune, parentDir } from "../lib/dupAlbums";
import {
  allFolderPaths,
  buildFolderTree,
  folderTrackList,
  type FolderNode,
} from "../lib/folderTree";
import {
  convertedOutputs,
  diffAudioFiles,
  mergeConverted,
} from "../lib/librarySync";

interface Props {
  settings: Settings;
  /** Track id -> Bandcamp key, for the "Bandcamp" origin badge. */
  originById: Record<string, string>;
  /** Mirrors the scanned tracks up to the app (for Bandcamp sync). */
  onTracksChange?: (tracks: TrackAnalysis[]) => void;
  /** Notifies the app of deleted files (to prune the Bandcamp download ledger). */
  onFilesDeleted?: (paths: string[]) => void;
  /** Shared header navigation (Library/Bandcamp tabs, downloads, gear). */
  nav?: ReactNode;
  onOpenSettings: () => void;
}

type Filter = "all" | "convert" | "incomplete";
type Grouping = "flat" | "album" | "folder";

export default function LibraryView({
  settings,
  originById,
  onTracksChange,
  onFilesDeleted,
  nav,
  onOpenSettings,
}: Props) {
  const [tracks, setTracks] = useState<TrackAnalysis[]>([]);
  const [loading, setLoading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [dedupeRunning, setDedupeRunning] = useState(false);
  const [dupGroups, setDupGroups] = useState<DuplicateGroup[]>([]);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<Record<string, ConvertProgress>>({});
  const [results, setResults] = useState<Record<string, ConvertResult>>({});
  const [edits, setEdits] = useState<Record<string, TrackEdit>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [writing, setWriting] = useState(false);
  // Undo history for tag writes: each entry holds the metadata as it was on disk
  // right before a write, so the last write can be reverted.
  const [undoStack, setUndoStack] = useState<
    { label: string; items: WriteMetadataItem[] }[]
  >([]);
  // When a bulk edit targets a folder (not the checkbox selection), the folder's
  // track ids are held here so applyBulk writes to them instead of `selected`.
  const [bulkFolderIds, setBulkFolderIds] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [grouping, setGrouping] = useState<Grouping>("album");
  const [expandedAlbums, setExpandedAlbums] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("artist");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [error, setError] = useState<string | null>(null);
  // Incremental (auto) sync in progress — drives the inline spinner.
  const [syncing, setSyncing] = useState(false);

  const libraryDir = settings.library_dir;
  // Only persist after the cache has been loaded – otherwise the initial
  // (empty) state overwrites the saved state on mount.
  const hydratedRef = useRef(false);
  // Latest values for the stable incrementalSync callback.
  const tracksRef = useRef<TrackAnalysis[]>([]);
  tracksRef.current = tracks;
  const loadingRef = useRef(false);
  loadingRef.current = loading;
  const syncingRef = useRef(false);
  const dirtyRef = useRef(false);

  // Starts a (background) full re-scan. If one is already running, the UI just docks onto it.
  const rescan = useCallback(async () => {
    if (!libraryDir) {
      setTracks([]);
      return;
    }
    setError(null);
    setLoading(true);
    void startScan(libraryDir);
  }, [libraryDir]);

  // Incremental sync: analyze only new files, drop deleted ones. Cheap enough to
  // run automatically on folder changes. Single-flight with a dirty re-run.
  const incrementalSync = useCallback(async () => {
    if (!libraryDir || loadingRef.current) return;
    if (syncingRef.current) {
      dirtyRef.current = true;
      return;
    }
    syncingRef.current = true;
    setSyncing(true);
    try {
      let current = tracksRef.current;
      do {
        dirtyRef.current = false;
        const disk = await listAudioFiles(libraryDir);
        const { addedPaths, keptTracks, changed } = diffAudioFiles(disk, current);
        if (!changed) break;
        const analyzed = addedPaths.length ? await analyzeFiles(addedPaths) : [];
        current = [...keptTracks, ...analyzed];
        setTracks(current);
        const valid = new Set(current.map((t) => t.path));
        setDupGroups((prev) => {
          const pruned = pruneGroups(prev, (p) => valid.has(p));
          if (pruned !== prev) void saveDuplicates(pruned);
          return pruned;
        });
      } while (dirtyRef.current);
    } catch (e) {
      setError(`Sync failed: ${e}`);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [libraryDir]);

  // Persistent scan listeners (one-time): progress + result.
  useEffect(() => {
    let unProg: (() => void) | undefined;
    let unDone: (() => void) | undefined;
    void (async () => {
      unProg = await onScanProgress((p) => {
        setLoading(p.running);
      });
      unDone = await onScanDone((d) => {
        setLoading(false);
        if (d.cancelled) return;
        setTracks(d.tracks);
        // Prune persisted duplicates against the current files.
        const valid = new Set(d.tracks.map((t) => t.path));
        setDupGroups((prev) => {
          const pruned = pruneGroups(prev, (p) => valid.has(p));
          if (pruned !== prev) void saveDuplicates(pruned);
          return pruned;
        });
      });
    })();
    return () => {
      unProg?.();
      unDone?.();
    };
  }, []);

  // Persistent dedupe listeners: running state + completion.
  useEffect(() => {
    let unProg: (() => void) | undefined;
    let unDone: (() => void) | undefined;
    void (async () => {
      unProg = await onDedupeProgress((p) => {
        setDedupeRunning(p.running);
      });
      unDone = await onDedupeDone((d) => {
        setDedupeRunning(false);
        // On success, persist and display the results.
        if (!d.cancelled) {
          setDupGroups(d.groups);
          void saveDuplicates(d.groups);
          setDupOpen(true);
        }
      });
    })();
    return () => {
      unProg?.();
      unDone?.();
    };
  }, []);

  // On start / folder change: immediately show the cached list, then dock onto
  // a running scan or start a new (background) scan. The list stays visible
  // in the meantime.
  useEffect(() => {
    let active = true;
    hydratedRef.current = false;
    void (async () => {
      const cache = await loadLibrary();
      if (active && cache && cache.library_dir === libraryDir) {
        setTracks(cache.tracks);
        setEdits(cache.edits ?? {});
      }
      const dups = await loadDuplicates();
      if (active && dups.length) setDupGroups(dups);
      // From now on persisting is allowed (the cache has been taken into account).
      hydratedRef.current = true;
      if (!active || !libraryDir) return;
      const status = await scanStatus();
      if (!active) return;
      if (status.running) {
        // Dock onto a running full scan instead of restarting.
        setLoading(true);
      } else {
        // Otherwise just reconcile incrementally against what's on disk.
        void incrementalSync();
      }
    })();
    return () => {
      active = false;
    };
  }, [libraryDir, incrementalSync]);

  // Keep the library folder watcher pointed at the current dir and run an
  // incremental sync whenever it reports a change.
  useEffect(() => {
    if (!libraryDir) return;
    void startLibraryWatch(libraryDir);
    let un: (() => void) | undefined;
    void onLibraryChanged(() => void incrementalSync()).then((fn) => {
      un = fn;
    });
    return () => {
      un?.();
      void startLibraryWatch("");
    };
  }, [libraryDir, incrementalSync]);

  // Keep the track database persisted (only after hydration, so the initial
  // empty state doesn't overwrite the cache).
  useEffect(() => {
    if (!libraryDir || !hydratedRef.current) return;
    void saveLibrary({ library_dir: libraryDir, tracks, edits });
  }, [libraryDir, tracks, edits]);

  // Mirror the scanned tracks up to the app (used by the Bandcamp sync).
  useEffect(() => {
    onTracksChange?.(tracks);
  }, [tracks, onTracksChange]);

  // Run conversion jobs.
  // - "library": source already lives in the library -> output to the same
  //   folder (output_dir=null) and delete the original after a format change.
  // - "import": external file -> copy into the library, keep the original.
  const runConvert = useCallback(
    async (jobs: ConvertJob[], mode: "library" | "import" = "library") => {
      if (!jobs.length) return;
      setConverting(true);
      setProgress({});
      setResults({});
      setError(null);
      const unlisten = await onConvertProgress((p) =>
        setProgress((prev) => ({ ...prev, [p.id]: p })),
      );
      try {
        const options: ConvertOptions = {
          format: settings.format,
          bit_depth: settings.bit_depth,
          output_dir: mode === "import" ? libraryDir : null,
          sanitize_filenames: settings.sanitize_filenames,
          replace_source: mode === "library",
        };
        const res = await convertTracks(jobs, options);
        const map: Record<string, ConvertResult> = {};
        res.forEach((r) => (map[r.id] = r));
        setResults(map);
        const failed = res.filter((r) => !r.success);
        if (failed.length) {
          setError(
            `${failed.length} file(s) failed: ${failed
              .map((f) => f.error)
              .filter(Boolean)
              .join("; ")}`,
          );
        }
        // Stop progress -> show "✓ Done" per row, leave it briefly,
        // then (for bulk only once all are done) refresh the list.
        unlisten();
        setConverting(false);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        setSelected(new Set());
        setProgress({});
        setResults({});
        // Re-analyze the converted outputs so their status/format refresh in
        // place — an in-place convert keeps the same path, which the disk diff
        // in incrementalSync() can't detect on its own.
        const outputs = convertedOutputs(res);
        if (outputs.length) {
          const analyzed = await analyzeFiles(outputs);
          setTracks((prev) => mergeConverted(prev, res, analyzed));
          // Drop edits of sources that a format change replaced with a new path
          // (their metadata is now written into the freshly analyzed output).
          setEdits((prev) => {
            let dirty = false;
            const next = { ...prev };
            for (const r of res) {
              if (
                r.success &&
                r.output_path &&
                r.output_path !== r.source_path &&
                next[r.source_path]
              ) {
                delete next[r.source_path];
                dirty = true;
              }
            }
            return dirty ? next : prev;
          });
        }
        await incrementalSync();
      } catch (e) {
        unlisten();
        setConverting(false);
        setError(`Conversion failed: ${e}`);
      }
    },
    [settings, libraryDir, incrementalSync],
  );

  const jobFor = useCallback(
    (t: TrackAnalysis): ConvertJob => {
      const edit = edits[t.id];
      return {
        id: t.id,
        path: t.path,
        metadata: edit?.metadata ?? null,
        cover: edit?.cover ?? null,
      };
    },
    [edits],
  );

  const convertSelected = useCallback(() => {
    const jobs = tracks.filter((t) => selected.has(t.id)).map(jobFor);
    void runConvert(jobs);
  }, [tracks, selected, jobFor, runConvert]);

  const convertOne = useCallback(
    (t: TrackAnalysis) => void runConvert([jobFor(t)]),
    [jobFor, runConvert],
  );

  // Drag & drop: convert files into the library.
  const importPaths = useCallback(
    async (paths: string[]) => {
      if (!libraryDir) {
        setError("Please choose a library folder in the settings first.");
        return;
      }
      const jobs: ConvertJob[] = paths.map((p) => ({
        id: p,
        path: p,
        metadata: null,
        cover: null,
      }));
      await runConvert(jobs, "import");
    },
    [libraryDir, runConvert],
  );

  const importRef = useRef(importPaths);
  importRef.current = importPaths;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          void importRef.current(event.payload.paths);
        } else {
          setDragging(false);
        }
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, []);

  // Anchor for the shift range selection (index into visibleTracks) and the
  // selection at anchor time (base onto which the shift range is applied).
  const anchorIndexRef = useRef<number | null>(null);
  const baseSelectionRef = useRef<Set<string>>(new Set());

  // Is a track incomplete (taking pending edits into account)?
  const isIncomplete = useCallback(
    (t: TrackAnalysis) => {
      const edit = edits[t.id];
      return edit ? !editComplete(edit) : t.metadata_incomplete;
    },
    [edits],
  );

  // Visible tracks according to filter + search.
  const visibleTracks = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tracks.filter((t) => {
      if (filter === "convert" && t.compat.compatible) return false;
      if (filter === "incomplete" && !isIncomplete(t)) return false;
      if (q) {
        const hay = [t.metadata.title, t.metadata.artist, t.metadata.album, t.file_name]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tracks, filter, search, isIncomplete]);

  // Grouping by album + top-level sorting (pure logic lives in lib/grouping).
  const albumItems = useMemo<AlbumItem[] | null>(
    () =>
      grouping === "album"
        ? buildAlbumItems(visibleTracks, edits, sortKey, sortDir)
        : null,
    [grouping, visibleTracks, edits, sortKey, sortDir],
  );

  // Flat (ungrouped) render order, sorted by the active column.
  const sortedFlat = useMemo(
    () =>
      grouping === "flat"
        ? sortTracks(visibleTracks, edits, sortKey, sortDir)
        : null,
    [grouping, visibleTracks, edits, sortKey, sortDir],
  );

  // Folder tree of the visible tracks (real directory structure).
  const folderRoot = useMemo(
    () =>
      grouping === "folder"
        ? buildFolderTree(visibleTracks, libraryDir ?? "")
        : null,
    [grouping, visibleTracks, libraryDir],
  );

  const allFolderKeys = useMemo(
    () => (folderRoot ? allFolderPaths(folderRoot) : []),
    [folderRoot],
  );

  // Flat render order (including collapsed) for the shift selection.
  const renderOrder = useMemo(() => {
    if (folderRoot) return folderTrackList(folderRoot);
    if (!albumItems) return sortedFlat ?? visibleTracks;
    const arr: TrackAnalysis[] = [];
    for (const it of albumItems) {
      if (it.type === "group") arr.push(...it.tracks);
      else arr.push(it.track);
    }
    return arr;
  }, [folderRoot, albumItems, sortedFlat, visibleTracks]);

  // Audio player: build a queue entry from an (edit-aware) track.
  const player = usePlayer();
  const toPlayerTrack = useCallback(
    (t: TrackAnalysis): PlayerTrack => {
      const m = edits[t.id]?.metadata ?? t.metadata;
      return {
        id: t.id,
        path: t.path,
        title: m.title || t.file_name,
        artist: m.artist || m.album_artist || "",
      };
    },
    [edits],
  );

  // Playing a track from a cover queues the whole visible list (so next/prev
  // browse it); an album cover queues just that album.
  const playFrom = useCallback(
    (list: TrackAnalysis[], index: number, positioned = false) => {
      player.play(list.map(toPlayerTrack), index, positioned);
    },
    [player, toPlayerTrack],
  );

  const allGroupKeys = useMemo(
    () =>
      (albumItems ?? [])
        .filter((it): it is Extract<AlbumItem, { type: "group" }> => it.type === "group")
        .map((it) => it.key),
    [albumItems],
  );

  // Column-header sort: same column toggles direction, a new column starts ascending.
  const toggleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortKey(key);
        setSortDir("asc");
      }
    },
    [sortKey],
  );

  const toggleAlbum = useCallback((key: string) => {
    setExpandedAlbums((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const toggleAllAlbums = useCallback(() => {
    setExpandedAlbums((prev) =>
      prev.size >= allGroupKeys.length && allGroupKeys.length > 0
        ? new Set()
        : new Set(allGroupKeys),
    );
  }, [allGroupKeys]);

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const toggleAllFolders = useCallback(() => {
    setExpandedFolders((prev) =>
      prev.size >= allFolderKeys.length && allFolderKeys.length > 0
        ? new Set()
        : new Set(allFolderKeys),
    );
  }, [allFolderKeys]);

  // (De)select all tracks of an album group.
  const toggleAlbumSelect = useCallback((tracksInAlbum: TrackAnalysis[]) => {
    setSelected((prev) => {
      const ids = tracksInAlbum.map((t) => t.id);
      const allSel = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSel) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);

  const allVisibleSelected =
    visibleTracks.length > 0 && visibleTracks.every((t) => selected.has(t.id));

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) => {
      const ids = visibleTracks.map((t) => t.id);
      const allSel = ids.length > 0 && ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSel) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, [visibleTracks]);

  // Row selection with shift range selection (classic file explorer style).
  const handleRowSelect = useCallback(
    (index: number, shiftKey: boolean) => {
      const id = renderOrder[index]?.id;
      if (!id) return;

      if (shiftKey && anchorIndexRef.current !== null) {
        // Reset the range: base + current anchor range. Rows that belonged to
        // an earlier (larger) range are thus dropped again.
        const start = Math.min(anchorIndexRef.current, index);
        const end = Math.max(anchorIndexRef.current, index);
        setSelected(() => {
          const next = new Set(baseSelectionRef.current);
          for (let i = start; i <= end; i++) {
            const rid = renderOrder[i]?.id;
            if (rid) next.add(rid);
          }
          return next;
        });
      } else {
        // Normal click: toggle individually, set anchor + base anew.
        setSelected((prev) => {
          const next = new Set(prev);
          next.has(id) ? next.delete(id) : next.add(id);
          baseSelectionRef.current = new Set(next);
          return next;
        });
        anchorIndexRef.current = index;
      }
    },
    [renderOrder],
  );

  // Writes confirmed metadata straight into the files, then swaps in the
  // re-analyzed tracks and clears the now-persisted pending edits. On failure
  // the pending edit is kept so the change isn't lost. Unless `recordUndo` is
  // false (i.e. this write *is* an undo), the pre-write metadata is snapshotted
  // so the write can be reverted.
  const writeToFiles = useCallback(
    async (reqs: WriteMetadataItem[], recordUndo = true, undoLabel?: string) => {
      if (!reqs.length) return;
      if (recordUndo) {
        const byPathNow = new Map(tracks.map((t) => [t.path, t]));
        const snapshot: WriteMetadataItem[] = [];
        for (const r of reqs) {
          const t = byPathNow.get(r.path);
          if (t) snapshot.push({ path: t.path, metadata: t.metadata });
        }
        if (snapshot.length) {
          setUndoStack((s) =>
            [
              ...s,
              { label: undoLabel ?? `${snapshot.length} track(s)`, items: snapshot },
            ].slice(-20),
          );
        }
      }
      setWriting(true);
      setError(null);
      try {
        const results = await writeMetadata(reqs);
        const byPath = new Map(results.map((r) => [r.path, r]));
        setTracks((prev) => prev.map((t) => byPath.get(t.path)?.track ?? t));
        const writtenIds = new Set(
          results.filter((r) => r.track).map((r) => r.track!.id),
        );
        if (writtenIds.size) {
          setEdits((prev) => {
            const next = { ...prev };
            for (const id of writtenIds) delete next[id];
            return next;
          });
        }
        const failed = results.filter((r) => r.error);
        if (failed.length) {
          setError(
            `Failed to write tags for ${failed.length} file(s): ${failed
              .map((f) => f.error)
              .filter(Boolean)
              .join("; ")}`,
          );
        }
      } catch (e) {
        setError(`Failed to write tags: ${e}`);
      } finally {
        setWriting(false);
      }
    },
    [tracks],
  );

  // Revert the last tag write, restoring the previous on-disk metadata.
  const undoLastWrite = useCallback(() => {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    setUndoStack((s) => s.slice(0, -1));
    void writeToFiles(entry.items, false);
  }, [undoStack, writeToFiles]);

  const saveEdit = useCallback(
    (id: string, edit: TrackEdit) => {
      const track = tracks.find((t) => t.id === id);
      setEditingId(null);
      if (!track) return;
      // Show the edit immediately; the write re-analyzes and clears it.
      setEdits((prev) => ({ ...prev, [id]: edit }));
      void writeToFiles([
        { path: track.path, metadata: edit.metadata, cover: edit.cover },
      ]);
    },
    [tracks, writeToFiles],
  );

  // Bulk edit: write the selected fields into all target tracks on disk.
  const applyBulkTo = useCallback(
    (patch: BulkPatch, targetIds: Set<string>) => {
      const reqs: WriteMetadataItem[] = [];
      for (const t of tracks) {
        if (!targetIds.has(t.id)) continue;
        const base = edits[t.id]?.metadata ?? t.metadata;
        reqs.push({ path: t.path, metadata: { ...base, ...patch } });
      }
      setBulkOpen(false);
      setBulkFolderIds(null);
      void writeToFiles(reqs);
    },
    [tracks, edits, writeToFiles],
  );

  const applyBulk = useCallback(
    (patch: BulkPatch) => applyBulkTo(patch, bulkFolderIds ?? selected),
    [applyBulkTo, bulkFolderIds, selected],
  );

  // Pending edits from before tags were written on save (persisted in the
  // cache): flush them all into the files in one go.
  const pendingEdits = useMemo(
    () => tracks.filter((t) => edits[t.id]),
    [tracks, edits],
  );

  const flushPendingEdits = useCallback(() => {
    const reqs: WriteMetadataItem[] = pendingEdits.map((t) => ({
      path: t.path,
      metadata: edits[t.id].metadata,
      cover: edits[t.id].cover,
    }));
    void writeToFiles(reqs);
  }, [pendingEdits, edits, writeToFiles]);

  // Apply a set of delete results to the live state (tracks, selection, dup
  // groups). Returns the removed paths, the still-remaining track paths (for
  // optional folder pruning) and the failed results.
  const applyDeletion = useCallback(
    (results: DeleteResult[]) => {
      const gone = new Set(
        results.filter((r) => r.success).map((r) => r.path),
      );
      let remaining: string[] = [];
      if (gone.size) {
        remaining = tracks
          .filter((t) => !gone.has(t.path))
          .map((t) => t.path);
        setTracks((prev) => prev.filter((t) => !gone.has(t.path)));
        setSelected((prev) => {
          const next = new Set(prev);
          gone.forEach((p) => next.delete(p));
          return next;
        });
        setDupGroups((prev) => {
          const pruned = pruneGroups(prev, (p) => !gone.has(p));
          void saveDuplicates(pruned);
          return pruned;
        });
        // Forget these files in the Bandcamp download ledger so a deleted
        // purchase can be synced again.
        onFilesDeleted?.([...gone]);
      }
      return { gone, remaining, failed: results.filter((r) => !r.success) };
    },
    [tracks, onFilesDeleted],
  );

  const raiseIfFailed = (failed: DeleteResult[]) => {
    if (failed.length) {
      throw new Error(
        failed.map((f) => f.error).filter(Boolean).join("; ") || "unknown",
      );
    }
  };

  // Move files to the trash and update groups/library live. Album folders that
  // end up without any remaining library track are removed too. Throws if any
  // deletion failed (the duplicates modal surfaces that).
  const deleteFilesAndPrune = useCallback(
    async (paths: string[]) => {
      const { gone, remaining, failed } = applyDeletion(
        await deleteFiles(paths),
      );
      if (gone.size) {
        // Remove now-empty album folders (backend re-checks for safety).
        const dirs = foldersToPrune([...gone], remaining);
        if (dirs.length) await pruneEmptyDirs(dirs).catch(() => []);
      }
      raiseIfFailed(failed);
    },
    [applyDeletion],
  );

  // Delete a whole album. When all of its tracks live in one folder, the folder
  // is trashed in a single operation (incl. artwork/side files); otherwise it
  // falls back to per-file deletion + folder pruning.
  const deleteAlbumTracks = useCallback(
    async (albumTracks: TrackAnalysis[]) => {
      const paths = albumTracks.map((t) => t.path);
      const dirs = new Set(paths.map(parentDir));
      if (dirs.size !== 1) {
        await deleteFilesAndPrune(paths);
        return;
      }
      const { failed } = applyDeletion(
        await deleteAlbum([...dirs][0], paths),
      );
      raiseIfFailed(failed);
    },
    [applyDeletion, deleteFilesAndPrune],
  );

  // Delete from the library with a confirmation (files go to the trash).
  const confirmAndDelete = useCallback(
    async (paths: string[], message: string) => {
      if (!paths.length) return;
      const ok = await ask(message, {
        title: "Delete",
        kind: "warning",
        okLabel: "Move to trash",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
      setError(null);
      try {
        await deleteFilesAndPrune(paths);
      } catch (e) {
        setError(`Deletion failed: ${e}`);
      }
    },
    [deleteFilesAndPrune],
  );

  // Confirm, then delete a whole album (folder-at-once when possible).
  const confirmAndDeleteAlbum = useCallback(
    async (albumTracks: TrackAnalysis[], message: string) => {
      if (!albumTracks.length) return;
      const ok = await ask(message, {
        title: "Delete",
        kind: "warning",
        okLabel: "Move to trash",
        cancelLabel: "Cancel",
      });
      if (!ok) return;
      setError(null);
      try {
        await deleteAlbumTracks(albumTracks);
      } catch (e) {
        setError(`Deletion failed: ${e}`);
      }
    },
    [deleteAlbumTracks],
  );

  // Folder view: open the bulk editor scoped to all tracks in a folder.
  const editFolder = useCallback((node: FolderNode) => {
    const ids = new Set(folderTrackList(node).map((t) => t.id));
    if (!ids.size) return;
    setBulkFolderIds(ids);
    setBulkOpen(true);
  }, []);

  const toggleFolderSelect = useCallback(
    (node: FolderNode) => toggleAlbumSelect(folderTrackList(node)),
    [toggleAlbumSelect],
  );

  // Confirm, then trash a whole folder (incl. subfolders and side files).
  const confirmAndDeleteFolder = useCallback(
    async (node: FolderNode) => {
      const paths = folderTrackList(node).map((t) => t.path);
      if (!paths.length) return;
      const ok = await ask(
        `Move the folder “${node.name}” (${paths.length} tracks) to the trash? The whole folder is removed.`,
        {
          title: "Delete",
          kind: "warning",
          okLabel: "Move to trash",
          cancelLabel: "Cancel",
        },
      );
      if (!ok) return;
      setError(null);
      try {
        const { failed } = applyDeletion(await deleteAlbum(node.path, paths));
        raiseIfFailed(failed);
      } catch (e) {
        setError(`Deletion failed: ${e}`);
      }
    },
    [applyDeletion],
  );

  // Dismiss a group ("not a duplicate") – persistent.
  const dismissDuplicateGroup = useCallback((id: string) => {
    setDupGroups((prev) => {
      const next = prev.filter((g) => g.id !== id);
      void saveDuplicates(next);
      return next;
    });
  }, []);

  const buildDupCandidates = useCallback(
    () =>
      tracks.map((t) => {
        const md = edits[t.id]?.metadata ?? t.metadata;
        return {
          id: t.id,
          path: t.path,
          name: md.title || t.file_name,
          codec: t.audio.codec,
          container: t.audio.container,
          sample_rate: t.audio.sample_rate,
          bits_per_sample: t.audio.bits_per_sample,
          lossless: t.audio.lossless,
          duration_secs: t.audio.duration_secs,
          compatible: t.compat.compatible,
          title: md.title,
          artist: md.artist,
          album_artist: md.album_artist,
          album: md.album,
          track_number: md.track_number,
        };
      }),
    [tracks, edits],
  );

  // Start a new scan (from the header or the modal's "Search again").
  const startDuplicateScan = useCallback(async () => {
    const status = await dedupeStatus();
    if (status.running) return;
    void startDedupe(buildDupCandidates());
  }, [buildDupCandidates]);

  // Header button: show existing results, otherwise start a new scan.
  const findDuplicates = useCallback(async () => {
    if (dupGroups.length > 0) {
      setDupOpen(true);
      return;
    }
    await startDuplicateScan();
  }, [dupGroups.length, startDuplicateScan]);

  // Existing values per field as selection suggestions (from tracks + edits).
  const fieldOptions = useMemo(() => {
    const collect = (get: (m: TrackAnalysis["metadata"]) => string | null) => {
      const set = new Set<string>();
      for (const t of tracks) {
        const md = edits[t.id]?.metadata ?? t.metadata;
        const v = get(md);
        if (v && v.trim()) set.add(v.trim());
      }
      return Array.from(set).sort((a, b) => a.localeCompare(b));
    };
    return {
      artist: collect((m) => m.artist),
      album: collect((m) => m.album),
      album_artist: collect((m) => m.album_artist),
      genre: collect((m) => m.genre),
      year: collect((m) => m.year),
      label: collect((m) => m.label),
      catalog_number: collect((m) => m.catalog_number),
      country: collect((m) => m.country),
    } as Record<string, string[]>;
  }, [tracks, edits]);

  // Sticky "docking" animation + back-to-top.
  const scrolled = useScrolled(4);
  const showTop = useScrolled(400);
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });

  // Primary actions for the header.
  const headerActions = (
    <>
      <button
        onClick={() => void rescan()}
        disabled={loading || converting || dedupeRunning}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-2 text-sm hover:border-accent-500 disabled:opacity-50"
      >
        {loading && <SpinnerIcon />}
        {loading ? "Scanning…" : "Rescan"}
      </button>
      {/* Auto-sync indicator (incremental), left of the Duplicates button. */}
      {syncing && !loading && (
        <span
          className="flex h-9 w-9 items-center justify-center text-fg-subtle"
          title="Updating library…"
          aria-label="Updating library"
        >
          <SpinnerIcon />
        </span>
      )}
      <button
        onClick={() => void findDuplicates()}
        disabled={
          loading ||
          converting ||
          dedupeRunning ||
          (dupGroups.length === 0 && tracks.length < 2)
        }
        className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-2 text-sm hover:border-accent-500 disabled:opacity-50"
        title="Find duplicate tracks across all formats"
      >
        {dedupeRunning && <SpinnerIcon />}
        {dedupeRunning
          ? "Finding duplicates…"
          : dupGroups.length > 0
            ? `Duplicates (${dupGroups.length})`
            : "Find duplicates"}
      </button>
      {writing && (
        <span
          className="flex h-9 w-9 items-center justify-center text-fg-subtle"
          title="Writing tags…"
          aria-label="Writing tags"
        >
          <SpinnerIcon />
        </span>
      )}
      {undoStack.length > 0 && (
        <button
          onClick={undoLastWrite}
          disabled={writing}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-2 text-sm hover:border-accent-500 disabled:opacity-50"
          title={`Undo the last tag write (${
            undoStack[undoStack.length - 1]?.label
          })`}
        >
          <UndoIcon />
          Undo
        </button>
      )}
      {pendingEdits.length > 0 && (
        <button
          onClick={flushPendingEdits}
          disabled={writing || converting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-warning-500/40 px-3 py-2 text-sm text-warning-500 hover:border-warning-500 disabled:opacity-50"
          title="Write metadata changes made earlier (not yet saved to the files) into the files"
        >
          {writing ? <SpinnerIcon /> : null}
          Write pending tags ({pendingEdits.length})
        </button>
      )}
      {selected.size > 0 && (
        <>
          <button
            onClick={() => setBulkOpen(true)}
            disabled={converting || writing}
            className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:border-accent-500 disabled:opacity-50"
          >
            Edit metadata ({selected.size})
          </button>
          <button
            onClick={convertSelected}
            disabled={converting}
            className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium hover:bg-accent-500 disabled:opacity-50"
          >
            {converting ? "Converting…" : `Convert selection (${selected.size})`}
          </button>
          <button
            onClick={() =>
              void confirmAndDelete(
                tracks.filter((t) => selected.has(t.id)).map((t) => t.path),
                `Move ${selected.size} selected track(s) to the trash? Empty folders are removed too.`,
              )
            }
            disabled={converting}
            className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:border-danger-500 hover:text-danger-500 disabled:opacity-50"
          >
            Delete ({selected.size})
          </button>
        </>
      )}
      {nav}
    </>
  );

  // ---- Empty states ----
  if (!libraryDir) {
    return (
      <>
        <AppHeader onTitleClick={scrollToTop} right={nav} />
        <main className="mx-auto max-w-6xl px-6 py-16">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-surface py-20 text-center text-fg-subtle">
            <p className="text-lg text-fg-muted">No library folder selected</p>
            <p className="text-sm">
              Set where your collection lives in the settings.
            </p>
            <button
              onClick={onOpenSettings}
              className="mt-2 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium hover:bg-accent-500"
            >
              Open settings
            </button>
          </div>
        </main>
      </>
    );
  }

  return (
    <>
      <AppHeader onTitleClick={scrollToTop} right={headerActions} />
      <main className="w-full px-6 py-6">
      {error && (
        <div className="mb-4 rounded-lg border border-danger-500/30 bg-danger-500/10 px-4 py-2 text-sm text-danger-500">
          {error}
        </div>
      )}

      {/* Filter bar (sticky below the header) */}
      {tracks.length > 0 && (
        <div
          className={`sticky top-16 z-20 -mx-6 mb-3 flex h-14 items-center gap-2 border-b px-6 transition-[box-shadow,background-color,border-color] duration-300 ${
            scrolled
              ? "border-border bg-bg/90 shadow-lg shadow-black/30 backdrop-blur"
              : "border-transparent bg-bg"
          }`}
        >
          <FilterChip
            active={filter === "all"}
            onClick={() => setFilter("all")}
            label={`All (${tracks.length})`}
          />
          <FilterChip
            active={filter === "convert"}
            onClick={() => setFilter("convert")}
            label={`To convert (${
              tracks.filter((t) => !t.compat.compatible).length
            })`}
          />
          <FilterChip
            active={filter === "incomplete"}
            onClick={() => setFilter("incomplete")}
            label={`Metadata incomplete (${tracks.filter(isIncomplete).length})`}
          />
          <div className="ml-auto flex items-center gap-2">
            {/* Grouping switch: flat list / by album / by folder tree. */}
            <div className="flex items-center rounded-full ring-1 ring-border-strong">
              {(
                [
                  ["flat", "Flat"],
                  ["album", "By album"],
                  ["folder", "By folder"],
                ] as [Grouping, string][]
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setGrouping(key)}
                  className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition-colors ${
                    grouping === key
                      ? "bg-accent-600 text-fg"
                      : "text-fg-muted hover:text-fg"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {grouping === "album" && allGroupKeys.length > 0 && (
              <button
                onClick={toggleAllAlbums}
                className="whitespace-nowrap rounded-full px-3 py-1.5 text-sm text-fg-muted ring-1 ring-border-strong transition-colors hover:text-fg hover:ring-border-strong"
              >
                {expandedAlbums.size >= allGroupKeys.length
                  ? "Collapse all"
                  : "Expand all"}
              </button>
            )}
            {grouping === "folder" && allFolderKeys.length > 0 && (
              <button
                onClick={toggleAllFolders}
                className="whitespace-nowrap rounded-full px-3 py-1.5 text-sm text-fg-muted ring-1 ring-border-strong transition-colors hover:text-fg hover:ring-border-strong"
              >
                {expandedFolders.size >= allFolderKeys.length
                  ? "Collapse all"
                  : "Expand all"}
              </button>
            )}
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-56 rounded-lg border border-border-strong bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-accent-500"
            />
          </div>
        </div>
      )}

      {/* Track list / drop zone */}
      <section
        className={`rounded-xl border transition-colors ${
          dragging
            ? "border-accent-500 bg-accent-500/5"
            : "border-border bg-surface"
        }`}
      >
        {tracks.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-fg-subtle">
            <p className="text-lg">
              {loading ? "Scanning…" : "No music in the library yet"}
            </p>
            {!loading && (
              <p className="text-sm">
                Drag files here – they will be converted into the library.
              </p>
            )}
          </div>
        ) : visibleTracks.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-fg-subtle">
            <p className="text-sm">No tracks match the filter.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[98rem] table-fixed text-sm">
            <thead className="text-left text-fg-muted">
              <tr className="border-b border-border">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-border-strong bg-surface-2"
                    aria-label="Select all"
                  />
                </th>
                <th className="w-14 px-4 py-3"></th>
                {/* Title has no fixed width: it absorbs the remaining space
                    (widest column); min table width keeps it ~600px+. */}
                <SortableHeader
                  label="Title"
                  sortKey="title"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                />
                <SortableHeader
                  label="Artist"
                  sortKey="artist"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                  className="w-40"
                />
                <SortableHeader
                  label="Album"
                  sortKey="album"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                  className="w-40"
                />
                <th className="w-44 px-4 py-3 font-medium">Format</th>
                <SortableHeader
                  label="Length"
                  sortKey="length"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                  className="w-20"
                />
                <th className="w-56 px-4 py-3 font-medium">Status</th>
                <SortableHeader
                  label="Downloaded"
                  sortKey="date"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                  className="w-32"
                />
                <th className="w-16 px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                const renderTrackRow = (
                  t: TrackAnalysis,
                  index: number,
                  depth = 0,
                ) => {
                const prog = progress[t.id];
                const result = results[t.id];
                const fromBandcamp = !!originById[t.id];
                // Show confirmed edits in the list immediately.
                const md = edits[t.id]?.metadata ?? t.metadata;
                return (
                  <tr
                    key={t.id}
                    onClick={() => setEditingId(t.id)}
                    className="group cursor-pointer border-b border-border last:border-0 hover:bg-surface-2"
                  >
                    <td
                      className="px-4 py-3"
                      style={depth ? { paddingLeft: 16 + depth * 20 } : undefined}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={() => {}}
                        onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRowSelect(index, e.shiftKey);
                        }}
                        className="h-4 w-4 rounded border-border-strong bg-surface-2"
                        aria-label={`Select ${t.file_name}`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <CoverThumb
                        path={t.path}
                        hasCover={t.metadata.has_cover}
                        onPlay={() => playFrom(renderOrder, index)}
                        active={player.current?.path === t.path}
                        playing={player.playing}
                        onToggle={player.toggle}
                      />
                    </td>
                    <td className="px-4 py-3 text-fg" title={t.path}>
                      <MarqueeText text={md.title || t.file_name} />
                    </td>
                    <td className="max-w-[10rem] truncate px-4 py-3 text-fg-muted">
                      {md.artist || "–"}
                    </td>
                    <td className="max-w-[10rem] truncate px-4 py-3 text-fg-muted">
                      {md.album || "–"}
                    </td>
                    <td className="truncate whitespace-nowrap px-4 py-3 text-fg-muted">
                      {formatLabel(
                        t.audio.codec,
                        t.audio.container,
                        t.audio.bits_per_sample,
                      )}
                      <span className="text-fg-subtle">
                        , {formatSampleRate(t.audio.sample_rate)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-fg-muted">
                      {formatDuration(t.audio.duration_secs)}
                    </td>
                    <td className="px-4 py-3">
                      {result ? (
                        result.success ? (
                          <span className="text-success-500">✓ Done</span>
                        ) : (
                          <span className="text-danger-500" title={result.error ?? ""}>
                            ✕ Error
                          </span>
                        )
                      ) : prog && converting ? (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-surface-2">
                            <div
                              className="h-full bg-accent-500 transition-all"
                              style={{ width: `${prog.percent}%` }}
                            />
                          </div>
                          <span className="text-xs text-fg-muted">
                            {prog.percent}%
                          </span>
                        </div>
                      ) : (
                        <div className="flex flex-wrap gap-1.5">
                          {trackBadges(t, edits[t.id], fromBandcamp).map((b, i) => (
                            <span
                              key={i}
                              title={b.title}
                              className={`rounded-full px-2 py-0.5 text-xs ring-1 ${b.className}`}
                            >
                              {b.label}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-fg-muted">
                      {formatDate(t.download_date)}
                    </td>
                    <td
                      className="relative px-4 py-3"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center gap-2 rounded-lg bg-surface-2 pl-3 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                        {!t.compat.compatible && (
                          <button
                            onClick={() => convertOne(t)}
                            disabled={converting}
                            className="rounded-md bg-accent-600 px-2 py-1 text-xs font-medium hover:bg-accent-500 disabled:opacity-40"
                            title="Convert to target format"
                          >
                            Convert
                          </button>
                        )}
                        <button
                          onClick={() => setEditingId(t.id)}
                          disabled={converting}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-accent-400 disabled:opacity-40"
                          title="Edit metadata"
                          aria-label="Edit metadata"
                        >
                          <EditIcon />
                        </button>
                        <button
                          onClick={() =>
                            void confirmAndDelete(
                              [t.path],
                              `Move “${md.title || t.file_name}” to the trash?`,
                            )
                          }
                          disabled={converting}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-danger-500 disabled:opacity-40"
                          title="Delete (move to trash)"
                          aria-label="Delete track"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
                };

                const rows: ReactNode[] = [];

                // Folder view: render the directory tree (folders + track leaves).
                const renderFolderNode = (
                  node: FolderNode,
                  depth: number,
                  idxRef: { i: number },
                ) => {
                  const nodeTracks = folderTrackList(node);
                  const allSel =
                    nodeTracks.length > 0 &&
                    nodeTracks.every((t) => selected.has(t.id));
                  const someSel =
                    !allSel && nodeTracks.some((t) => selected.has(t.id));
                  const expanded = expandedFolders.has(node.path);
                  rows.push(
                    <tr
                      key={`f-${node.path}`}
                      onClick={() => toggleFolder(node.path)}
                      className="group cursor-pointer border-b border-border bg-surface-2/40 hover:bg-surface-2"
                    >
                      <td
                        className="px-4 py-2.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={allSel}
                          ref={(el) => {
                            if (el) el.indeterminate = someSel;
                          }}
                          onChange={() => toggleFolderSelect(node)}
                          className="h-4 w-4 rounded border-border-strong bg-surface-2"
                          aria-label={`Select ${node.name}`}
                        />
                      </td>
                      <td
                        colSpan={8}
                        className="px-4 py-2.5"
                        style={{ paddingLeft: 16 + depth * 20 }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-fg-subtle">
                            <ChevronIcon open={expanded} />
                          </span>
                          <span className="min-w-0 truncate font-medium text-fg">
                            {node.name}
                          </span>
                          <span className="shrink-0 whitespace-nowrap pl-2 text-xs text-fg-subtle">
                            {nodeTracks.length} tracks
                          </span>
                        </div>
                      </td>
                      <td
                        className="relative px-4 py-2.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center gap-2 rounded-lg bg-surface-2 pl-3 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                          <button
                            onClick={() => editFolder(node)}
                            disabled={writing}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-accent-400 disabled:opacity-40"
                            title="Edit metadata for all tracks in this folder"
                            aria-label="Edit folder metadata"
                          >
                            <EditIcon />
                          </button>
                          <button
                            onClick={() => void confirmAndDeleteFolder(node)}
                            disabled={converting}
                            className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-danger-500 disabled:opacity-40"
                            title="Delete folder (move to trash)"
                            aria-label="Delete folder"
                          >
                            <TrashIcon />
                          </button>
                        </div>
                      </td>
                    </tr>,
                  );
                  if (expanded) {
                    for (const child of node.folders)
                      renderFolderNode(child, depth + 1, idxRef);
                    node.tracks.forEach((t) => {
                      rows.push(renderTrackRow(t, idxRef.i++, depth + 1));
                    });
                  } else {
                    idxRef.i += nodeTracks.length;
                  }
                };

                if (folderRoot) {
                  const idxRef = { i: 0 };
                  for (const child of folderRoot.folders)
                    renderFolderNode(child, 0, idxRef);
                  folderRoot.tracks.forEach((t) =>
                    rows.push(renderTrackRow(t, idxRef.i++, 0)),
                  );
                } else if (albumItems) {
                  let idx = 0;
                  for (const it of albumItems) {
                    if (it.type === "track") {
                      rows.push(renderTrackRow(it.track, idx));
                      idx++;
                      continue;
                    }
                    const expanded = expandedAlbums.has(it.key);
                    const gTracks = it.tracks;
                    const allSel = gTracks.every((t) => selected.has(t.id));
                    const someSel =
                      !allSel && gTracks.some((t) => selected.has(t.id));
                    const cover = gTracks[0];
                    const albumArtist = albumArtistOf(cover, edits);
                    const needConvert = gTracks.filter(
                      (t) => !t.compat.compatible,
                    ).length;
                    const needIncomplete = gTracks.filter(isIncomplete).length;
                    // Format: shared label (without sample rate), else "Mixed".
                    const formats = new Set(
                      gTracks.map((t) =>
                        formatLabel(
                          t.audio.codec,
                          t.audio.container,
                          t.audio.bits_per_sample,
                        ),
                      ),
                    );
                    const albumFormat =
                      formats.size === 1 ? [...formats][0] : "Mixed";
                    const albumLength = gTracks.reduce(
                      (s, t) => s + t.audio.duration_secs,
                      0,
                    );
                    const albumDate = Math.max(
                      ...gTracks.map((t) => t.download_date ?? 0),
                    );
                    const albumFromBandcamp = gTracks.some(
                      (t) => !!originById[t.id],
                    );
                    rows.push(
                      <tr
                        key={`g-${it.key}`}
                        onClick={() => toggleAlbum(it.key)}
                        className="group cursor-pointer border-b border-border bg-surface-2/40 hover:bg-surface-2"
                      >
                        <td
                          className="px-4 py-2.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={allSel}
                            ref={(el) => {
                              if (el) el.indeterminate = someSel;
                            }}
                            onChange={() => toggleAlbumSelect(gTracks)}
                            className="h-4 w-4 rounded border-border-strong bg-surface-2"
                            aria-label={`Select ${it.key}`}
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <CoverThumb
                            path={cover.path}
                            hasCover={cover.metadata.has_cover}
                            onPlay={() => playFrom(gTracks, 0, true)}
                            active={gTracks.some(
                              (t) => t.path === player.current?.path,
                            )}
                            playing={player.playing}
                            onToggle={player.toggle}
                          />
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2">
                            <span className="shrink-0 text-fg-subtle">
                              <ChevronIcon open={expanded} />
                            </span>
                            <MarqueeText
                              text={it.key}
                              className="min-w-0 font-medium text-fg"
                            />
                            <span className="shrink-0 whitespace-nowrap pl-2 text-xs text-fg-subtle">
                              {gTracks.length} tracks
                            </span>
                          </div>
                        </td>
                        <td className="max-w-[10rem] truncate px-4 py-2.5 text-fg-muted">
                          {albumArtist || "–"}
                        </td>
                        <td className="truncate px-4 py-2.5 text-fg-muted">
                          {it.key}
                        </td>
                        <td className="truncate whitespace-nowrap px-4 py-2.5 text-fg-muted">
                          {albumFormat}
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">
                          {formatDuration(albumLength)}
                        </td>
                        <td className="px-4 py-2.5">
                          <div className="flex flex-wrap gap-1.5">
                            {needConvert > 0 && (
                              <span className="rounded-full bg-warning-500/15 px-2 py-0.5 text-xs text-warning-500 ring-1 ring-warning-500/30">
                                Convert ({needConvert})
                              </span>
                            )}
                            {needIncomplete > 0 && (
                              <span className="rounded-full bg-warning-500/15 px-2 py-0.5 text-xs text-warning-500 ring-1 ring-warning-500/30">
                                Metadata incomplete ({needIncomplete})
                              </span>
                            )}
                            {albumFromBandcamp && (
                              <span className="rounded-full bg-accent-500/15 px-2 py-0.5 text-xs text-accent-300 ring-1 ring-accent-500/30">
                                Bandcamp
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">
                          {formatDate(albumDate)}
                        </td>
                        <td
                          className="relative px-4 py-2.5"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center rounded-lg bg-surface-2 pl-3 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                            <button
                              onClick={() =>
                                void confirmAndDeleteAlbum(
                                  gTracks,
                                  `Move the album “${it.key}” (${gTracks.length} files) to the trash? The whole folder is removed.`,
                                )
                              }
                              disabled={converting}
                              className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-danger-500 disabled:opacity-40"
                              title="Delete album (move to trash)"
                              aria-label="Delete album"
                            >
                              <TrashIcon />
                            </button>
                          </div>
                        </td>
                      </tr>,
                    );
                    if (expanded) {
                      gTracks.forEach((t) => {
                        rows.push(renderTrackRow(t, idx));
                        idx++;
                      });
                    } else {
                      idx += gTracks.length;
                    }
                  }
                } else {
                  renderOrder.forEach((t, i) =>
                    rows.push(renderTrackRow(t, i)),
                  );
                }
                return rows;
              })()}
            </tbody>
          </table>
          </div>
        )}
      </section>

      {editingId &&
        (() => {
          const track = tracks.find((t) => t.id === editingId);
          if (!track) return null;
          return (
            <MetadataEditor
              track={track}
              initial={edits[editingId]}
              fieldOptions={fieldOptions}
              discogsKey={settings.discogs_key}
              discogsSecret={settings.discogs_secret}
              onClose={() => setEditingId(null)}
              onSave={(edit) => saveEdit(editingId, edit)}
            />
          );
        })()}

      {bulkOpen && (
        <BulkMetadataEditor
          count={(bulkFolderIds ?? selected).size}
          suggestions={fieldOptions}
          onClose={() => {
            setBulkOpen(false);
            setBulkFolderIds(null);
          }}
          onApply={applyBulk}
        />
      )}

      {dupOpen && (
        <DuplicatesModal
          groups={dupGroups}
          scanning={dedupeRunning}
          onClose={() => setDupOpen(false)}
          onDeleteFiles={deleteFilesAndPrune}
          onDismissGroup={dismissDuplicateGroup}
          onRescan={() => void startDuplicateScan()}
        />
      )}
      </main>

      {/* Back-to-top */}
      <button
        onClick={scrollToTop}
        aria-label="Back to top"
        className={`fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-border-strong bg-surface text-fg shadow-lg shadow-black/40 backdrop-blur transition-all duration-300 hover:border-accent-500 hover:text-accent-400 ${
          showTop
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-4 opacity-0"
        }`}
      >
        <ArrowUpIcon />
      </button>
    </>
  );
}

function SortableHeader({
  label,
  sortKey,
  activeKey,
  dir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  activeKey: SortKey;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = activeKey === sortKey;
  return (
    <th className={`px-4 py-3 font-medium ${className ?? ""}`} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        onClick={() => onSort(sortKey)}
        className="group inline-flex items-center gap-1 hover:text-fg"
      >
        <span className={active ? "text-fg" : undefined}>{label}</span>
        <span
          className={`text-xs ${
            active
              ? "text-accent-400"
              : "text-fg-subtle opacity-0 group-hover:opacity-60"
          }`}
        >
          {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

function FilterChip({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1.5 text-sm ring-1 transition-colors ${
        active
          ? "bg-accent-600/20 text-accent-200 ring-accent-500/40"
          : "text-fg-muted ring-border hover:text-fg hover:ring-border-strong"
      }`}
    >
      {label}
    </button>
  );
}
