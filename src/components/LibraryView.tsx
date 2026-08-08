import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  onScanTracks,
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
  trackStatus,
  type TrackStatus,
} from "../lib/format";
import type { Settings } from "../lib/settings";
import type {
  ConvertJob,
  ConvertOptions,
  ConvertProgress,
  ConvertResult,
  DeleteResult,
  DuplicateGroup,
  ScanProgress,
  TrackAnalysis,
  TrackEdit,
} from "../types";
import { STAGE_ANALYZING, STAGE_BPM } from "../types";
import MetadataEditor from "./MetadataEditor";
import BulkMetadataEditor, { type BulkPatch } from "./BulkMetadataEditor";
import CoverThumb from "./CoverThumb";
import { usePlayer, type PlayerTrack } from "../lib/player";
import MarqueeText from "./MarqueeText";
import DuplicatesModal from "./DuplicatesModal";
import AppHeader from "./AppHeader";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronIcon,
  EditIcon,
  SpinnerIcon,
  TrashIcon,
  UndoIcon,
  XIcon,
} from "./icons";
import StatusIcons from "./StatusIcons";
import { useScrolled } from "../lib/useScrolled";
import { scanLabel as buildScanLabel, type BootPhase } from "../lib/boot";
import { useReplayAnimation } from "../lib/useReplayAnimation";
import { Skeleton, TrackTableSkeleton } from "./Skeleton";
import { resizeHeights, visibleRange, type Range } from "../lib/virtualList";
import {
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
  allLabelIds,
  buildLabelTree,
  labelTrackList,
  type LabelNode,
} from "../lib/labelTree";
import { albumsLabel, summarizeGroup } from "../lib/groupSummary";
import {
  convertedOutputs,
  diffAudioFiles,
  mergeConverted,
  mergeScanned,
  pathsMissingBpm,
} from "../lib/librarySync";
import {
  activeFilterChips,
  clearFacet,
  collectGenres,
  EMPTY_FILTER,
  filterCounts,
  filterTracks,
  type FilterContext,
  type TrackFilter,
} from "../lib/trackFilter";
import FilterMenu from "./FilterMenu";

interface Props {
  settings: Settings;
  /** Track id -> Bandcamp key, for the "Bandcamp" origin badge. */
  originById: Record<string, string>;
  /** Mirrors the scanned tracks up to the app (for Bandcamp sync). */
  onTracksChange?: (tracks: TrackAnalysis[]) => void;
  /** Reports start-up progress to the splash (see lib/boot). */
  onBootPhase?: (phase: BootPhase, progress?: ScanProgress | null) => void;
  /** Notifies the app of deleted files (to prune the Bandcamp download ledger). */
  onFilesDeleted?: (paths: string[]) => void;
  /** Shared header navigation (Library/Bandcamp tabs, downloads, gear). */
  nav?: ReactNode;
  onOpenSettings: () => void;
}

/** Minimum gap between writes of the library cache (see the save effect). */
const SAVE_THROTTLE_MS = 3000;

/**
 * The same gap while a scan streams results. Much longer on purpose: the cache
 * is several megabytes, and rewriting it every few seconds churned enough JSON
 * to grow the process by ~130 MB per minute, which throttled the run itself.
 * Measured over one two-minute window: 32 files processed, 254 MB gained — the
 * growth tracked elapsed time, not work done. Losing up to this much of the
 * cache costs nothing: the tags are already on disk and a scan re-reads them.
 */
const SAVE_THROTTLE_SCANNING_MS = 30_000;

type Grouping = "flat" | "album" | "folder" | "label";

export default function LibraryView({
  settings,
  originById,
  onTracksChange,
  onBootPhase,
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
  const [filter, setFilter] = useState<TrackFilter>(EMPTY_FILTER);
  const [search, setSearch] = useState("");
  const [grouping, setGrouping] = useState<Grouping>("album");
  const [expandedAlbums, setExpandedAlbums] = useState<Set<string>>(new Set());
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  // Label view: holds both label and album node ids (see lib/labelTree).
  const [expandedLabels, setExpandedLabels] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>("artist");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [error, setError] = useState<string | null>(null);
  // Stage + counters of the running scan; the BPM pass can take minutes, so it
  // needs more than a spinner.
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  // Incremental (auto) sync in progress — drives the inline spinner.
  const [syncing, setSyncing] = useState(false);
  // False until the cached library has been read. Distinct from `loading`
  // (which means a scan is running) and from an empty library: without it the
  // list would render its "no music" empty state during the store read.
  const [hydrated, setHydrated] = useState(false);

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
    void startScan(libraryDir, settings.analyze_bpm);
  }, [libraryDir, settings.analyze_bpm]);

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
        // No BPM here — the background job below picks it up, so the sync
        // stays fast no matter how many files arrived.
        const analyzed = addedPaths.length ? await analyzeFiles(addedPaths) : [];
        current = [...keptTracks, ...analyzed];
        setTracks(current);
      } while (dirtyRef.current);
    } catch (e) {
      setError(`Sync failed: ${e}`);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [libraryDir]);

  // Paths already handed to a BPM run this session. Without this, files whose
  // tempo cannot be detected would be re-queued forever, since they keep
  // showing up as "missing a BPM".
  const bpmAttemptedRef = useRef<Set<string>>(new Set());

  // Hands whatever still lacks a BPM to the scan job, in the background. Cheap
  // to call: it is a no-op when nothing is missing or a job is already running,
  // which is what lets it be triggered from every place the library changes.
  const startBpmBacklog = useCallback(() => {
    if (!libraryDir || !settings.analyze_bpm) return;
    const paths = pathsMissingBpm(tracksRef.current).filter(
      (p) => !bpmAttemptedRef.current.has(p),
    );
    if (!paths.length) return;
    void startScan(libraryDir, true, paths).then((started) => {
      // Only mark them once the job actually took them, otherwise a run that
      // lost the single-flight race would never be retried.
      if (started) paths.forEach((p) => bpmAttemptedRef.current.add(p));
    });
  }, [libraryDir, settings.analyze_bpm]);

  // The scan-done listener is registered once, so it reaches the current
  // callback through a ref instead of capturing a stale one.
  const backlogRef = useRef(startBpmBacklog);
  useEffect(() => {
    backlogRef.current = startBpmBacklog;
  }, [startBpmBacklog]);

  // Persistent scan listeners (one-time): progress, streamed tracks, result.
  useEffect(() => {
    let unProg: (() => void) | undefined;
    let unTracks: (() => void) | undefined;
    let unDone: (() => void) | undefined;
    void (async () => {
      unProg = await onScanProgress((p) => {
        // Only the probing pass blocks the UI. The BPM pass runs alongside for
        // minutes and must not disable converting or the duplicate search.
        setLoading(p.running && p.stage === STAGE_ANALYZING);
        setScanProgress(p.running ? p : null);
      });
      // Results stream in while the job runs; merging them here is what makes
      // them visible and (via the library-save effect) persisted straight away,
      // so a cancel or a quit costs at most one batch.
      unTracks = await onScanTracks((t) => {
        setTracks((prev) => mergeScanned(prev, t.tracks));
      });
      unDone = await onScanDone((d) => {
        setLoading(false);
        // A full sweep is the only run that may drop tracks: it saw every file,
        // so anything it did not report is gone from disk. A targeted run only
        // touched a subset, and a cancelled one did not even finish that.
        if (!d.cancelled && d.full) setTracks(d.tracks);
        // Keep working through the library: a full sweep leaves a backlog, and
        // a targeted run may have been capped by the single-flight guard. Not
        // after a cancel — that was a deliberate stop.
        if (!d.cancelled) backlogRef.current();
      });
    })();
    return () => {
      unProg?.();
      unTracks?.();
      unDone?.();
    };
  }, []);

  // Duplicate groups must never reference files that are gone. This follows the
  // track list rather than a single event, because the scan streams its updates.
  useEffect(() => {
    const valid = new Set(tracks.map((t) => t.path));
    setDupGroups((prev) => {
      const pruned = pruneGroups(prev, (p) => valid.has(p));
      if (pruned !== prev) void saveDuplicates(pruned);
      return pruned;
    });
  }, [tracks]);

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
      if (active) setHydrated(true);
      if (!active || !libraryDir) return;
      const status = await scanStatus();
      if (!active) return;
      if (status.running) {
        // Dock onto a running full scan instead of restarting.
        setLoading(true);
      } else {
        // Otherwise just reconcile incrementally against what's on disk, then
        // start chewing through whatever still has no tempo.
        await incrementalSync();
        if (!active) return;
        backlogRef.current();
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
    // New files on disk get analyzed, then queued for their tempo.
    void onLibraryChanged(() => {
      void incrementalSync().then(() => backlogRef.current());
    }).then((fn) => {
      un = fn;
    });
    return () => {
      un?.();
      void startLibraryWatch("");
    };
  }, [libraryDir, incrementalSync]);

  // Keep the track database persisted (only after hydration, so the initial
  // empty state doesn't overwrite the cache).
  //
  // Throttled rather than debounced: the scan streams its results, so a plain
  // debounce would keep resetting and never save at all, while saving per batch
  // would rewrite the whole multi-megabyte store ~90 times per run. The wait
  // shrinks with the time since the last save, so writes happen at a steady
  // interval and the most that can be lost on a quit is one window. During a
  // scan the interval widens (see SAVE_THROTTLE_SCANNING_MS); when the scan
  // ends, `scanning` flips and this re-runs, so the final state lands promptly.
  const lastSaveRef = useRef(0);
  const scanning = scanProgress !== null;
  useEffect(() => {
    if (!libraryDir || !hydratedRef.current) return;
    const interval = scanning ? SAVE_THROTTLE_SCANNING_MS : SAVE_THROTTLE_MS;
    const wait = Math.max(0, interval - (Date.now() - lastSaveRef.current));
    const id = setTimeout(() => {
      lastSaveRef.current = Date.now();
      void saveLibrary({ library_dir: libraryDir, tracks, edits });
    }, wait);
    return () => clearTimeout(id);
  }, [libraryDir, tracks, edits, scanning]);

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

  // Everything the pure filter cannot derive from a track on its own.
  const filterCtx = useMemo<FilterContext>(
    () => ({
      edits,
      isIncomplete,
      isFromBandcamp: (t) => !!originById[t.id],
    }),
    [edits, isIncomplete, originById],
  );

  // Visible tracks according to filter + search (pure logic in lib/trackFilter).
  const visibleTracks = useMemo(
    () => filterTracks(tracks, filter, search, filterCtx),
    [tracks, filter, search, filterCtx],
  );

  // Tallies over the whole library, for the filter menu and its chips. One pass
  // instead of one per counter.
  const counts = useMemo(
    () => filterCounts(tracks, filterCtx),
    [tracks, filterCtx],
  );

  const genreOptions = useMemo(
    () => collectGenres(tracks, edits),
    [tracks, edits],
  );
  const activeChips = useMemo(() => activeFilterChips(filter), [filter]);
  // Whether the list is narrowed at all — the search counts, the chips do not
  // cover it.
  const filtering = activeChips.length > 0 || search.trim() !== "";

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

  // Label tree of the visible tracks (label -> album -> tracks).
  const labelRoot = useMemo(
    () =>
      grouping === "label"
        ? buildLabelTree(visibleTracks, edits, sortKey, sortDir)
        : null,
    [grouping, visibleTracks, edits, sortKey, sortDir],
  );

  const allLabelKeys = useMemo(
    () => (labelRoot ? allLabelIds(labelRoot) : []),
    [labelRoot],
  );

  // Flat render order (including collapsed) for the shift selection.
  const renderOrder = useMemo(() => {
    if (folderRoot) return folderTrackList(folderRoot);
    if (labelRoot) return labelTrackList(labelRoot);
    if (!albumItems) return sortedFlat ?? visibleTracks;
    const arr: TrackAnalysis[] = [];
    for (const it of albumItems) {
      if (it.type === "group") arr.push(...it.tracks);
      else arr.push(it.track);
    }
    return arr;
  }, [folderRoot, labelRoot, albumItems, sortedFlat, visibleTracks]);

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

  const toggleLabel = useCallback((id: string) => {
    setExpandedLabels((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleAllLabels = useCallback(() => {
    setExpandedLabels((prev) =>
      prev.size >= allLabelKeys.length && allLabelKeys.length > 0
        ? new Set()
        : new Set(allLabelKeys),
    );
  }, [allLabelKeys]);

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

  // The BPM pass runs in the background for minutes, so the button reports it
  // without blocking: "Scanning…" while probing, "BPM 412/2223" afterwards.
  const bpmRunning = scanProgress?.stage === STAGE_BPM;
  const scanLabel = buildScanLabel(scanProgress);

  // Tell the splash how far along we are. It comes down as soon as the list is
  // displayable — a first scan runs for minutes, and the table's own loading
  // state covers that far better than a splash would.
  useEffect(() => {
    if (!onBootPhase) return;
    if (!hydrated) return;
    const emptyAndScanning =
      tracks.length === 0 && !!libraryDir && (loading || !!scanProgress);
    if (emptyAndScanning) onBootPhase("scanning", scanProgress);
    else onBootPhase("ready");
  }, [
    onBootPhase,
    hydrated,
    tracks.length,
    libraryDir,
    loading,
    scanProgress,
  ]);

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

  // Label view: open the bulk editor scoped to a label or one of its albums.
  const editTracks = useCallback((list: TrackAnalysis[]) => {
    const ids = new Set(list.map((t) => t.id));
    if (!ids.size) return;
    setBulkFolderIds(ids);
    setBulkOpen(true);
  }, []);

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

  // Row virtualisation. The table scrolls with the page, so the window is
  // derived from the tbody's own rect — no bookkeeping of page offset needed.
  // Heights are measured rather than assumed: a status column that wraps to two
  // badge lines makes a row taller, and a fixed height would drift.
  const bodyRef = useRef<HTMLTableSectionElement>(null);
  const rangeRef = useRef<Range>({ start: 0, end: 0, paddingTop: 0, paddingBottom: 0 });
  const [rowHeights, setRowHeights] = useState<number[]>([]);
  const [viewport, setViewport] = useState({ top: 0, height: 0 });

  // What the rendered rows are made of. Anything that reorders or replaces
  // them belongs in here — see the two effects below.
  const listSignature = useMemo(
    () =>
      [grouping, sortKey, sortDir, search.trim(), JSON.stringify(filter)].join(
        "|",
      ),
    [grouping, sortKey, sortDir, search, filter],
  );

  // Fade the list in whenever it is recomposed, so a filter or sort change
  // reads as a transition rather than a jump.
  const listRef = useReplayAnimation<HTMLDivElement>(listSignature);

  // Measured heights are keyed by position over a list that mixes group
  // headers and track rows, and resizeHeights only grows or truncates it. After
  // a recompose, index i may well be a header where a track row was measured,
  // which puts the visible window in the wrong place for a frame. Start over
  // instead; the rows re-measure in the same layout pass, hidden by the fade.
  useEffect(() => {
    setRowHeights([]);
  }, [listSignature]);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = bodyRef.current?.getBoundingClientRect().top ?? 0;
      setViewport((prev) =>
        prev.top === top && prev.height === window.innerHeight
          ? prev
          : { top, height: window.innerHeight },
      );
    };
    const onScroll = () => {
      // One measurement per frame: scroll events fire far more often than that.
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  // After every render, record what the rendered rows actually measure, so the
  // next window lands in the right place. Only rows in the current range are
  // present in the DOM; the rest keep their estimate until they scroll in.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const { start } = rangeRef.current;
    let index = start;
    let changed = false;
    const next = rowHeights.slice();
    for (const child of Array.from(body.children)) {
      if ((child as HTMLElement).dataset.spacer !== undefined) continue;
      const h = (child as HTMLElement).getBoundingClientRect().height;
      if (h > 0 && index < next.length && Math.abs(next[index] - h) > 0.5) {
        next[index] = h;
        changed = true;
      }
      index++;
    }
    if (changed) setRowHeights(next);
  });

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
        title={bpmRunning ? "Detecting BPM in the background" : undefined}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border-strong px-3 py-2 text-sm hover:border-accent-500 disabled:opacity-50"
      >
        {(loading || bpmRunning) && <SpinnerIcon />}
        {loading || bpmRunning ? scanLabel : "Rescan"}
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

      {/* Filter bar (sticky below the header). While the cache is still being
          read its shape is held by placeholders, so the list below does not
          jump down once it appears. */}
      {!hydrated ? (
        <div className="-mx-6 mb-3 flex h-14 items-center gap-2 border-b border-transparent px-6">
          <Skeleton className="h-7 w-28" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="h-8 w-72 rounded-full" />
            <Skeleton className="h-9 w-9" />
            <Skeleton className="h-8 w-56 rounded-lg" />
          </div>
        </div>
      ) : (
        tracks.length > 0 && (
        <div
          className={`sticky top-16 z-20 -mx-6 mb-3 flex h-14 items-center gap-2 border-b px-6 transition-[box-shadow,background-color,border-color] duration-300 ${
            scrolled
              ? "border-border bg-bg/90 shadow-lg shadow-black/30 backdrop-blur"
              : "border-transparent bg-bg"
          }`}
        >
          {/* Left: how much is shown, then one removable chip per active
              facet. Nothing filtered = just the total. */}
          <span className="shrink-0 whitespace-nowrap text-sm text-fg-muted">
            {filtering
              ? `${visibleTracks.length} of ${counts.total} tracks`
              : `${counts.total} tracks`}
          </span>
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
            {activeChips.map((chip) => (
              <FilterChip
                key={chip.facet}
                label={chip.label}
                onRemove={() => setFilter(clearFacet(filter, chip.facet))}
              />
            ))}
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {/* Grouping switch: flat list / by album / by folder tree / by label. */}
            <div className="flex items-center rounded-full ring-1 ring-border-strong">
              {(
                [
                  ["flat", "Flat"],
                  ["album", "By album"],
                  ["folder", "By folder"],
                  ["label", "By label"],
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
            {grouping === "label" && allLabelKeys.length > 0 && (
              <button
                onClick={toggleAllLabels}
                className="whitespace-nowrap rounded-full px-3 py-1.5 text-sm text-fg-muted ring-1 ring-border-strong transition-colors hover:text-fg hover:ring-border-strong"
              >
                {expandedLabels.size >= allLabelKeys.length
                  ? "Collapse all"
                  : "Expand all"}
              </button>
            )}
            <FilterMenu
              filter={filter}
              onChange={setFilter}
              genres={genreOptions}
              counts={counts}
            />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-56 rounded-lg border border-border-strong bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-accent-500"
            />
          </div>
        </div>
        )
      )}

      {/* Track list / drop zone */}
      <section
        className={`rounded-xl border transition-colors ${
          dragging
            ? "border-accent-500 bg-accent-500/5"
            : "border-border bg-surface"
        }`}
      >
        {/* Skeleton while the cached library is being read, and while a scan
            is filling an empty list — never for the BPM pass, which updates
            rows that are already on screen. */}
        {(!hydrated || (tracks.length === 0 && loading)) ? (
          <TrackTableSkeleton rows={8} />
        ) : tracks.length === 0 ? (
          <div className="animate-fade-in flex h-64 flex-col items-center justify-center gap-2 text-fg-subtle">
            <p className="text-lg">No music in the library yet</p>
            <p className="text-sm">
              Drag files here – they will be converted into the library.
            </p>
          </div>
        ) : visibleTracks.length === 0 ? (
          <div className="animate-fade-in flex h-40 flex-col items-center justify-center gap-2 text-fg-subtle">
            <p className="text-sm">No tracks match the filter.</p>
          </div>
        ) : (
          <div ref={listRef} className="animate-fade-in overflow-x-auto">
          <table className="w-full min-w-[95rem] table-fixed text-sm">
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
                <SortableHeader
                  label="BPM"
                  sortKey="bpm"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                  className="w-20"
                />
                <SortableHeader
                  label="Downloaded"
                  sortKey="date"
                  activeKey={sortKey}
                  dir={sortDir}
                  onSort={toggleSort}
                  className="w-32"
                />
                <th className="w-24 px-4 py-3 font-medium">Status</th>
                <th className="w-16 px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody ref={bodyRef}>
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
                    <td className="whitespace-nowrap px-4 py-3 text-fg-muted">
                      {md.bpm ?? "–"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-fg-muted">
                      {formatDate(t.download_date)}
                    </td>
                    <td className="px-4 py-3">
                      {result ? (
                        result.success ? (
                          <span
                            className="flex text-success-500"
                            title="Converted"
                            aria-label="Converted"
                            role="img"
                          >
                            <CheckIcon />
                          </span>
                        ) : (
                          <span
                            className="flex text-danger-500"
                            title={result.error ?? "Conversion failed"}
                            aria-label="Conversion failed"
                            role="img"
                          >
                            <XIcon />
                          </span>
                        )
                      ) : prog && converting ? (
                        <div
                          className="flex items-center gap-1.5 text-fg-muted"
                          title={`Converting – ${prog.percent}%`}
                        >
                          <SpinnerIcon />
                          <span className="text-xs">{prog.percent}%</span>
                        </div>
                      ) : (
                        <StatusIcons
                          items={trackStatus(t, edits[t.id], fromBandcamp)}
                        />
                      )}
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
                // One header row for every kind of group (album, label, folder)
                // so a group shows the same columns everywhere. `cover` is only
                // passed where one artwork really represents the group.
                const renderGroupHeader = (opts: {
                  id: string;
                  title: string;
                  depth: number;
                  tracks: TrackAnalysis[];
                  expanded: boolean;
                  onToggle: () => void;
                  cover?: TrackAnalysis;
                  /** Album column override; defaults to "N albums". */
                  albumText?: string;
                  actions?: ReactNode;
                }) => {
                  const { tracks: gTracks, depth } = opts;
                  const s = summarizeGroup(gTracks, edits, isIncomplete);
                  const allSel =
                    gTracks.length > 0 && gTracks.every((t) => selected.has(t.id));
                  const someSel =
                    !allSel && gTracks.some((t) => selected.has(t.id));
                  const fromBandcamp = gTracks.some((t) => !!originById[t.id]);
                  // Same markers as a track row, but summarising the group —
                  // the counts are rendered next to the icons.
                  const groupStatus: TrackStatus[] = [];
                  if (s.needConvert > 0) {
                    groupStatus.push({
                      kind: "convert",
                      title: "Tracks needing conversion",
                    });
                  }
                  if (s.needIncomplete > 0) {
                    groupStatus.push({
                      kind: "incomplete",
                      title: "Tracks with incomplete metadata",
                    });
                  }
                  if (fromBandcamp) {
                    groupStatus.push({ kind: "bandcamp", title: "From Bandcamp" });
                  }
                  rows.push(
                    <tr
                      key={opts.id}
                      onClick={opts.onToggle}
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
                          aria-label={`Select ${opts.title}`}
                        />
                      </td>
                      <td className="px-4 py-2.5">
                        {opts.cover && (
                          <CoverThumb
                            path={opts.cover.path}
                            hasCover={opts.cover.metadata.has_cover}
                            onPlay={() => playFrom(gTracks, 0, true)}
                            active={gTracks.some(
                              (t) => t.path === player.current?.path,
                            )}
                            playing={player.playing}
                            onToggle={player.toggle}
                          />
                        )}
                      </td>
                      <td
                        className="px-4 py-2.5"
                        style={depth ? { paddingLeft: 16 + depth * 20 } : undefined}
                      >
                        <div className="flex items-center gap-2">
                          <span className="shrink-0 text-fg-subtle">
                            <ChevronIcon open={opts.expanded} />
                          </span>
                          <MarqueeText
                            text={opts.title}
                            className="min-w-0 font-medium text-fg"
                          />
                          <span className="shrink-0 whitespace-nowrap pl-2 text-xs text-fg-subtle">
                            {s.count} tracks
                          </span>
                        </div>
                      </td>
                      <td className="max-w-[10rem] truncate px-4 py-2.5 text-fg-muted">
                        {s.albumArtist || "–"}
                      </td>
                      <td className="truncate px-4 py-2.5 text-fg-muted">
                        {opts.albumText ?? albumsLabel(s.albums)}
                      </td>
                      <td className="truncate whitespace-nowrap px-4 py-2.5 text-fg-muted">
                        {s.format}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">
                        {formatDuration(s.totalLength)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">
                        {s.bpm}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-fg-muted">
                        {formatDate(s.newestDate)}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusIcons
                          items={groupStatus}
                          counts={{
                            convert: s.needConvert,
                            incomplete: s.needIncomplete,
                          }}
                        />
                      </td>
                      <td
                        className="relative px-4 py-2.5"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {opts.actions && (
                          <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center gap-2 rounded-lg bg-surface-2 pl-3 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                            {opts.actions}
                          </div>
                        )}
                      </td>
                    </tr>,
                  );
                };

                const renderFolderNode = (
                  node: FolderNode,
                  depth: number,
                  idxRef: { i: number },
                ) => {
                  const nodeTracks = folderTrackList(node);
                  const expanded = expandedFolders.has(node.path);
                  renderGroupHeader({
                    id: `f-${node.path}`,
                    title: node.name,
                    depth,
                    tracks: nodeTracks,
                    expanded,
                    onToggle: () => toggleFolder(node.path),
                    actions: (
                      <>
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
                      </>
                    ),
                  });
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

                const renderLabelNode = (
                  node: LabelNode,
                  idxRef: { i: number },
                ) => {
                  const expanded = expandedLabels.has(node.id);
                  renderGroupHeader({
                    id: node.id,
                    title: node.name,
                    depth: 0,
                    tracks: node.all,
                    expanded,
                    onToggle: () => toggleLabel(node.id),
                    actions: (
                      <button
                        onClick={() => editTracks(node.all)}
                        disabled={writing}
                        className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-accent-400 disabled:opacity-40"
                        title="Edit metadata for all tracks of this label"
                        aria-label="Edit label metadata"
                      >
                        <EditIcon />
                      </button>
                    ),
                  });
                  if (!expanded) {
                    idxRef.i += node.all.length;
                    return;
                  }
                  for (const album of node.albums) {
                    const albumExpanded = expandedLabels.has(album.id);
                    renderGroupHeader({
                      id: album.id,
                      title: album.album,
                      depth: 1,
                      tracks: album.tracks,
                      expanded: albumExpanded,
                      onToggle: () => toggleLabel(album.id),
                      cover: album.tracks[0],
                      albumText: album.album,
                      actions: (
                        <button
                          onClick={() =>
                            void confirmAndDeleteAlbum(
                              album.tracks,
                              `Move the album “${album.album}” (${album.tracks.length} files) to the trash? The whole folder is removed.`,
                            )
                          }
                          disabled={converting}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-danger-500 disabled:opacity-40"
                          title="Delete album (move to trash)"
                          aria-label="Delete album"
                        >
                          <TrashIcon />
                        </button>
                      ),
                    });
                    if (albumExpanded) {
                      album.tracks.forEach((t) => {
                        rows.push(renderTrackRow(t, idxRef.i++, 2));
                      });
                    } else {
                      idxRef.i += album.tracks.length;
                    }
                  }
                  node.tracks.forEach((t) => {
                    rows.push(renderTrackRow(t, idxRef.i++, 1));
                  });
                };

                if (labelRoot) {
                  const idxRef = { i: 0 };
                  for (const node of labelRoot) renderLabelNode(node, idxRef);
                } else if (folderRoot) {
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
                    renderGroupHeader({
                      id: `g-${it.key}`,
                      title: it.key,
                      depth: 0,
                      tracks: gTracks,
                      expanded,
                      onToggle: () => toggleAlbum(it.key),
                      cover: gTracks[0],
                      albumText: it.key,
                      actions: (
                        <button
                          onClick={() =>
                            void confirmAndDeleteAlbum(
                              gTracks,
                              `Move the album \u201C${it.key}\u201D (${gTracks.length} files) to the trash? The whole folder is removed.`,
                            )
                          }
                          disabled={converting}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-danger-500 disabled:opacity-40"
                          title="Delete album (move to trash)"
                          aria-label="Delete album"
                        >
                          <TrashIcon />
                        </button>
                      ),
                    });
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

                // Render only the visible window. The heights table is grown to
                // match the row count here, so a grouping switch or a filter
                // change is picked up without a separate effect.
                const heights = resizeHeights(rowHeights, rows.length);
                const range = visibleRange(heights, viewport.top, viewport.height);
                rangeRef.current = range;
                return [
                  range.paddingTop > 0 && (
                    <tr key="pad-top" data-spacer="" style={{ height: range.paddingTop }} />
                  ),
                  ...rows.slice(range.start, range.end),
                  range.paddingBottom > 0 && (
                    <tr
                      key="pad-bottom"
                      data-spacer=""
                      style={{ height: range.paddingBottom }}
                    />
                  ),
                ];
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

/** One active filter facet, removable via the trailing ✕. */
function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-accent-600/20 py-1.5 pl-3 pr-1.5 text-sm text-accent-200 ring-1 ring-accent-500/40">
      {label}
      <button
        onClick={onRemove}
        className="flex h-5 w-5 items-center justify-center rounded-full text-accent-200/70 transition-colors hover:bg-accent-500/20 hover:text-accent-200"
        title={`Remove filter: ${label}`}
        aria-label={`Remove filter: ${label}`}
      >
        ✕
      </button>
    </span>
  );
}
