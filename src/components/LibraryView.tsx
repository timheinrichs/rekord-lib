import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  analyzeFiles,
  convertTracks,
  deleteAlbum,
  deleteFiles,
  listAudioFiles,
  onConvertProgress,
  onDedupeDone,
  onDedupeProgress,
  onLibraryChanged,
  onScanDone,
  onScanProgress,
  onScanSkipped,
  onScanPatch,
  onScanTracks,
  pickOutputDir,
  pruneEmptyDirs,
  scanStatus,
  setScanPaused,
  sidecarError,
  startLibraryWatch,
  startScan,
  undoLast,
  undoPeek,
  writeMetadata,
  type UndoEntry,
  type WriteMetadataItem,
  type WriteMetadataResult,
} from "../lib/api";
import {
  applyWrittenTracks,
  writeErrorMessage,
  writtenIds,
} from "../lib/writeResults";
import {
  clearEdits,
  forgetTracks,
  isLibraryDirAvailable,
  loadEdits,
  loadLibraryTracks,
  relocateLibrary,
  saveEdit as persistEdit,
} from "../lib/library";
import { relocateMessage, shouldRelocate } from "../lib/relocate";
import { visibleColumns, type ColumnDef, type ColumnId } from "../lib/columns";
import { addSkipped, skippedLabel } from "../lib/skipped";
import { dismissDuplicates, loadDuplicates, saveDuplicates } from "../lib/duplicates";
import {
  bpmIsUncertain,
  editComplete,
  formatBpm,
  formatKey,
  keyDetail,
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
  SkippedFile,
  TrackAnalysis,
  TrackEdit,
  TrackMetadata,
} from "../types";
import { STAGE_ANALYZING } from "../types";
import MetadataEditor from "./MetadataEditor";
import BulkMetadataEditor, { type BulkPatch } from "./BulkMetadataEditor";
import CoverThumb, { forgetCoverThumbs } from "./CoverThumb";
import PlaylistMenu from "./PlaylistMenu";
import AddToPlaylist from "./AddToPlaylist";
import { usePlayer, type PlayerTrack } from "../lib/player";
import { usePlaylists } from "../lib/usePlaylists";
import { buildPlaylistGroups, wouldAdd } from "../lib/playlists";
import { exportRekordbox } from "../lib/api";
import MarqueeText from "./MarqueeText";
import DuplicatesModal from "./DuplicatesModal";
import SkippedModal from "./SkippedModal";
import AppHeader from "./AppHeader";
import {
  ScanIcon,
  CheckIcon,
  ChevronIcon,
  EditIcon,
  PauseIcon,
  PlayIcon,
  SpinnerIcon,
  TrashIcon,
  UndoIcon,
  XIcon,
} from "./icons";
import StatusIcons from "./StatusIcons";
import { listenerGroup } from "../lib/listenerGroup";
import { useScrolled } from "../lib/useScrolled";
import {
  scanButtonState,
  scanLabel as buildScanLabel,
  type BootPhase,
} from "../lib/boot";
import { useReplayAnimation } from "../lib/useReplayAnimation";
import { Skeleton, TrackTableSkeleton } from "./Skeleton";
import { resizeHeights, visibleRange, type Range } from "../lib/virtualList";
import {
  buildAlbumItems,
  DEFAULT_GROUPING,
  GROUPINGS,
  pruneGroups,
  sortTracks,
  type AlbumItem,
  type Grouping,
  type SortKey,
} from "../lib/grouping";
import { foldersToPrune, parentDir } from "../lib/dupAlbums";
import {
  buildFolderTree,
  folderTrackList,
  type FolderNode,
} from "../lib/folderTree";
import {
  buildLabelTree,
  labelTrackList,
  type LabelNode,
} from "../lib/labelTree";
import { albumsLabel, summarizeGroup, type GroupSummary } from "../lib/groupSummary";
import {
  applyPatch,
  convertedOutputs,
  diffAudioFiles,
  mergeConverted,
  mergeScanned,
  pathsMissingBpm,
} from "../lib/librarySync";
import { createPatchCollector, waveformPaths } from "../lib/scanPatchBatch";
import {
  activeFilterChips,
  clearFacet,
  collectGenres,
  collectKeys,
  EMPTY_FILTER,
  filterCounts,
  filterTracks,
  type FilterContext,
  type TrackFilter,
} from "../lib/trackFilter";
import ColumnMenu from "./ColumnMenu";
import RowWaveform, {
  forgetRowWaveforms,
  refreshRowWaveforms,
} from "./RowWaveform";
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
  /** Re-points the library after the folder was found again (see lib/relocate). */
  onLibraryDirChange?: (dir: string) => void;
  /**
   * Persists a settings change made from the library toolbar — the column
   * choice. Optional so the component can be rendered without it.
   */
  onSettingsChange?: (patch: Partial<Settings>) => void;
}

/**
 * How long the scan button confirms a finished run before going back to its
 * resting label. Matches the pause the conversion flow leaves on its per-row
 * "converted" tick, so the two acknowledgements feel like the same app.
 */
const SCAN_FINISHED_MS = 1200;

/**
 * How long the "re-linked" line stays after a relocate. It acknowledges what
 * just happened rather than describing a state, so it clears itself instead of
 * sitting above the library for the rest of the session.
 */
const RELINK_MESSAGE_MS = 8000;


export default function LibraryView({
  settings,
  onSettingsChange,
  originById,
  onTracksChange,
  onBootPhase,
  onFilesDeleted,
  nav,
  onOpenSettings,
  onLibraryDirChange,
}: Props) {
  const [tracks, setTracks] = useState<TrackAnalysis[]>([]);
  const [loading, setLoading] = useState(false);
  const [converting, setConverting] = useState(false);
  // Brief confirmation in the scan button after a run completes.
  const [scanFinished, setScanFinished] = useState(false);
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
  // The tag write that can be taken back next. The history itself lives in the
  // database, written by the backend from the files' actual tags — so an undo
  // survives a restart, and it restores what was really on disk rather than
  // what this view happened to be showing.
  const [undoEntry, setUndoEntry] = useState<UndoEntry | null>(null);
  // When a bulk edit targets a folder (not the checkbox selection), the folder's
  // track ids are held here so applyBulk writes to them instead of `selected`.
  const [bulkFolderIds, setBulkFolderIds] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<TrackFilter>(EMPTY_FILTER);
  const [search, setSearch] = useState("");
  const [grouping, setGrouping] = useState<Grouping>(DEFAULT_GROUPING);
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
  // The library folder is configured but cannot be listed — renamed, moved, or
  // on a volume that is not mounted. Distinct from an empty library, which is
  // what it would otherwise look like here.
  const [dirMissing, setDirMissing] = useState(false);
  // Why the bundled ffmpeg/ffprobe cannot be used here, if that is the case.
  // Nothing the app does works without them, so it is said once and stays said.
  const [sidecarBroken, setSidecarBroken] = useState<string | null>(null);
  // Files the analysis had to leave out, with the reason each one gave. A scan
  // over a mixed collection always meets a few; skipping them is right, doing
  // it silently was not.
  const [skipped, setSkipped] = useState<SkippedFile[]>([]);
  const [skippedOpen, setSkippedOpen] = useState(false);
  // Outcome of the last re-link, shown once the folder is back.
  const [relocated, setRelocated] = useState<string | null>(null);

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
    // A full sweep meets every file again, so it reports its own skips from
    // scratch rather than adding to the last run's.
    setSkipped([]);
    setLoading(true);
    void startScan(libraryDir, settings.analyze_bpm, undefined, false, false, {
      min: settings.bpm_min,
      max: settings.bpm_max,
    });
  }, [libraryDir, settings.analyze_bpm, settings.bpm_min, settings.bpm_max]);

  // Incremental sync: analyze only new files, drop deleted ones. Cheap enough to
  // run automatically on folder changes. Single-flight with a dirty re-run.
  // Reconciles the list against what is on disk and returns what it ended up
  // with.
  //
  // Both the argument and the return value exist for the same reason:
  // `tracksRef` is assigned during *render*, so a caller that has just called
  // `setTracks` — or that is about to read the result — would otherwise work
  // with the list from before. Getting that wrong is not cosmetic: reading a
  // stale (empty) list here makes every stored track look new, so a start-up
  // sync re-analyses the whole library and never notices a file that is gone.
  const incrementalSync = useCallback(
    async (from?: TrackAnalysis[]): Promise<TrackAnalysis[]> => {
    const known = from ?? tracksRef.current;
    if (!libraryDir || loadingRef.current) return known;
    if (syncingRef.current) {
      dirtyRef.current = true;
      return known;
    }
    syncingRef.current = true;
    setSyncing(true);
    try {
      let current = known;
      do {
        dirtyRef.current = false;
        // A folder that cannot be listed is passed on as `null`, not as an
        // empty listing: the diff must not read a renamed or unmounted library
        // as "every file was deleted".
        const available = await isLibraryDirAvailable(libraryDir);
        setDirMissing(!available);
        const disk = available ? await listAudioFiles(libraryDir) : null;
        const { addedPaths, keptTracks, removedPaths, changed } = diffAudioFiles(
          disk,
          current,
        );
        if (!changed) break;
        // Files that vanished outside the app (a move in Finder, an external
        // delete) have to leave the database too — otherwise the next start
        // would serve them from the cache again.
        if (removedPaths.length) await forgetTracks(removedPaths);
        current = keptTracks;
        setTracks(current);
        // New files go to the scan job, not to `analyze_files`.
        //
        // They used to go to the blocking command, which is why the first fill
        // of a library had no progress and could not be held: on ten thousand
        // files that was several minutes of a spinner with no counter and no way
        // to stop it — the run a user would most want to pause. The job does the
        // same probing in its first phase, but it reports counters, it takes the
        // pause gate, and it persists as it goes, so a quit costs one batch
        // instead of the whole run.
        //
        // The rows therefore arrive through `scan://tracks` rather than being
        // returned here, and this loop no longer waits for them. That is the
        // point: the sync is now only the diff.
        if (addedPaths.length) {
          // The tempo comes along in the same run when it is wanted. A separate
          // backlog pass over the same files would decode each one twice.
          await startScan(
            libraryDir,
            settings.analyze_bpm,
            addedPaths,
            false,
            false,
            { min: settings.bpm_min, max: settings.bpm_max },
          );
          // No handling of a `false` return: it means a scan already owns the
          // library, and the scan-done listener runs the backlog again when it
          // finishes. Marking these paths as done here is what would lose them.
        }
      } while (dirtyRef.current);
      return current;
    } catch (e) {
      setError(`Sync failed: ${e}`);
      // Whatever the sync had managed before it failed — the caller's fallback
      // is the pre-sync list either way.
      return known;
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
    },
    [libraryDir, settings.analyze_bpm, settings.bpm_min, settings.bpm_max],
  );

  // Paths already handed to a BPM run this session. Without this, files whose
  // tempo cannot be detected would be re-queued forever, since they keep
  // showing up as "missing a BPM".
  const bpmAttemptedRef = useRef<Set<string>>(new Set());

  // Hands whatever still lacks a BPM to the scan job, in the background. Cheap
  // to call: it is a no-op when nothing is missing or a job is already running,
  // which is what lets it be triggered from every place the library changes.
  //
  // `from` exists because of a race that cost a fresh library its tempos: called
  // straight after a sync, `tracksRef` still held the pre-sync list, so nothing
  // looked to be missing a BPM and no job started — detection only began on the
  // next launch. Callers that have just produced a list pass it in.
  const startBpmBacklog = useCallback(
    (from?: TrackAnalysis[]) => {
      if (!libraryDir || !settings.analyze_bpm) return;
      const paths = pathsMissingBpm(from ?? tracksRef.current).filter(
        (p) => !bpmAttemptedRef.current.has(p),
      );
      if (!paths.length) return;
      void startScan(libraryDir, true, paths, false, false, {
        min: settings.bpm_min,
        max: settings.bpm_max,
      }).then((started) => {
        // Only mark them once the job actually took them, otherwise a run that
        // lost the single-flight race would never be retried.
        if (started) paths.forEach((p) => bpmAttemptedRef.current.add(p));
      });
    },
    [libraryDir, settings.analyze_bpm, settings.bpm_min, settings.bpm_max],
  );

  // The scan-done listener is registered once, so it reaches the current
  // callback through a ref instead of capturing a stale one.
  const backlogRef = useRef(startBpmBacklog);
  useEffect(() => {
    backlogRef.current = startBpmBacklog;
  }, [startBpmBacklog]);

  // Is the configured folder actually there? Checked whenever it changes and
  // whenever a scan ends, because a sweep that walked a folder which is no
  // longer there returns nothing — which would otherwise read as an empty
  // library rather than as something to fix.
  const checkLibraryDir = useCallback(() => {
    if (!libraryDir) {
      setDirMissing(false);
      return;
    }
    void isLibraryDirAvailable(libraryDir)
      .then((ok) => setDirMissing(!ok))
      // A failed check is not evidence that the folder is gone.
      .catch(() => setDirMissing(false));
  }, [libraryDir]);

  useEffect(checkLibraryDir, [checkLibraryDir]);

  // The backend tests the sidecars at startup; this only reads the verdict.
  // Retried once because the check runs off the launch path and may not have
  // finished when the view first mounts.
  useEffect(() => {
    let active = true;
    const read = () =>
      void sidecarError()
        .then((e) => {
          if (active) setSidecarBroken(e);
        })
        .catch(() => {});
    read();
    const t = setTimeout(read, 3000);
    return () => {
      active = false;
      clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    if (!relocated) return;
    const t = setTimeout(() => setRelocated(null), RELINK_MESSAGE_MS);
    return () => clearTimeout(t);
  }, [relocated]);

  const checkDirRef = useRef(checkLibraryDir);
  useEffect(() => {
    checkDirRef.current = checkLibraryDir;
  }, [checkLibraryDir]);

  // Where the scan's per-file results are gathered before they reach the list.
  // Created once: the setter is stable and the waveform batcher is module-level,
  // so nothing here needs to be rebuilt when this component re-renders.
  const patches = useMemo(
    () =>
      createPatchCollector((batch) => {
        setTracks((prev) => applyPatch(prev, batch));
        // The waveform is not a field of the row — it lives in its own table and
        // is fetched by the row that draws it, so a stored waveform is announced
        // to the batcher rather than merged into the track.
        const drawn = waveformPaths(batch);
        if (drawn.length) refreshRowWaveforms(drawn);
      }),
    [],
  );

  // Persistent scan listeners (one-time): progress, streamed tracks, result.
  // Registered through a listenerGroup so an unsubscriber that arrives after
  // cleanup still gets called — see that module for what leaked without it.
  useEffect(() => {
    const group = listenerGroup();
    void (async () => {
      group.add(
        await onScanProgress((p) => {
          // Only the probing pass blocks the UI. The BPM pass runs alongside for
          // minutes and must not disable converting or the duplicate search.
          setLoading(p.running && p.stage === STAGE_ANALYZING);
          setScanProgress(p.running ? p : null);
        }),
      );
      // Results stream in while the job runs; merging them here is what makes
      // them visible straight away, so a cancel or a quit costs at most one batch.
      group.add(
        await onScanTracks((t) => {
          setTracks((prev) => mergeScanned(prev, t.tracks));
          // Only the files this batch really re-probed: those changed on disk,
          // and another app may have rewritten their artwork. The batch also
          // carries rows reused from the database, and forgetting those would
          // re-decode a thumbnail per visible row on every scan, for nothing.
          forgetCoverThumbs(t.fresh);
        }),
      );
      // The tempo/key/waveform pass reports every file on its own, so a row
      // fills in while the run is still going. Gathered on a window first — see
      // `scanPatchBatch` for why one update per file would cost too much.
      group.add(await onScanPatch((p) => patches.add(p.patch)));
      // Files the analysis could not use, reported one by one as they happen.
      group.add(
        await onScanSkipped((f) => setSkipped((prev) => addSkipped(prev, f))),
      );
      group.add(
        await onScanDone((d) => {
          setLoading(false);
          // Only a run that got to the end has something to confirm.
          if (!d.cancelled) setScanFinished(true);
          // A full sweep is the only run that may drop tracks: it saw every file,
          // so anything it did not report is gone from disk. A targeted run only
          // touched a subset, and a cancelled one did not even finish that.
          if (!d.cancelled && d.full) setTracks(d.tracks);
          // Rows that were on screen while this ran asked before their waveform
          // existed and were told there is none; they have to be asked again or
          // they stay blank until they remount. Also after a cancel: the
          // analysis stores per track, so a run stopped halfway still stored
          // some.
          forgetRowWaveforms();
          // Keep working through the library: a full sweep leaves a backlog, and
          // a targeted run may have been capped by the single-flight guard. Not
          // after a cancel — that was a deliberate stop.
          if (!d.cancelled) backlogRef.current();
          // A sweep that found nothing may have been looking at a folder that
          // is no longer there.
          checkDirRef.current();
        }),
      );
    })();
    return () => {
      group.dispose();
      patches.stop();
    };
  }, [patches]);

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
    const group = listenerGroup();
    void (async () => {
      group.add(
        await onDedupeProgress((p) => {
          setDedupeRunning(p.running);
        }),
      );
      group.add(
        await onDedupeDone((d) => {
          setDedupeRunning(false);
          // Take the result, but do not put it on screen: the search is a scan
          // phase now, so it finishes without anyone having asked for it, and
          // popping the panel open would interrupt whatever the user was doing.
          // The header button is the way in — it appears as soon as there is
          // something to show.
          if (!d.cancelled) {
            setDupGroups(d.groups);
            void saveDuplicates(d.groups);
          }
        }),
      );
    })();
    return () => group.dispose();
  }, []);

  // On start / folder change: immediately show the cached list, then dock onto
  // a running scan or start a new (background) scan. The list stays visible
  // in the meantime.
  useEffect(() => {
    let active = true;
    hydratedRef.current = false;
    void (async () => {
      // Every read here goes through the database, and the backend starts
      // without one on purpose: `db::require` reports it rather than panicking,
      // because an empty library the next scan rebuilds beats refusing to
      // launch. So a failure must not take the boot down with it — it costs the
      // cache, not the folder, and the sweep below can still find every file on
      // disk. Reported rather than swallowed, because an unreadable library
      // that looks like an empty one is the worse of the two.
      const cached = async <T,>(read: Promise<T>, fallback: T): Promise<T> => {
        try {
          return await read;
        } catch (e) {
          if (active) setError(`Could not read the library cache: ${e}`);
          return fallback;
        }
      };

      // Rows are stored per library folder, so this only ever returns tracks
      // that belong to the current one — no folder check needed here.
      const [stored, storedEdits] = await Promise.all([
        libraryDir
          ? cached(loadLibraryTracks(libraryDir), [] as TrackAnalysis[])
          : Promise.resolve([] as TrackAnalysis[]),
        cached(loadEdits(), {} as Record<string, TrackEdit>),
      ]);
      if (active && stored.length) setTracks(stored);
      if (active) setEdits(storedEdits);
      const dups = await cached(loadDuplicates(), [] as DuplicateGroup[]);
      if (active && dups.length) setDupGroups(dups);
      // From now on persisting is allowed (the cache has been taken into account).
      hydratedRef.current = true;
      if (active) setHydrated(true);
      if (!active || !libraryDir) return;
      // Not through `cached`: `scan_status` reads an atomic in memory and never
      // touches the database, so reporting a failure of it as a cache problem
      // would point at the wrong subsystem. Falling back to "nothing running" is
      // the recoverable branch either way — assuming a scan is in flight would
      // leave a spinner up forever.
      const status = await scanStatus().catch((e) => {
        if (active) setError(`Could not read the scan status: ${e}`);
        return {
          running: false,
          paused: false,
          generation: 0,
          done: 0,
          total: 0,
          stage: "",
        };
      });
      if (!active) return;
      if (status.running) {
        // Dock onto a running full scan instead of restarting.
        setLoading(true);
      } else {
        // Otherwise just reconcile incrementally against what's on disk, then
        // start chewing through whatever still has no tempo.
        const synced = await incrementalSync(stored);
        if (!active) return;
        backlogRef.current(synced);
      }
    })();
    return () => {
      active = false;
    };
  }, [libraryDir, incrementalSync]);

  // "Locate folder…": re-point the library at where it went, keeping every
  // track's identity, then let the app store the new folder.
  const relocateTo = useCallback(async () => {
    const dir = await pickOutputDir();
    if (!dir || !libraryDir) return;
    setRelocated(null);
    if (shouldRelocate(libraryDir, dir)) {
      try {
        setRelocated(relocateMessage(await relocateLibrary(libraryDir, dir)));
      } catch (e) {
        // The folder still changes: a failed re-link costs the cached rows,
        // not the files, and leaving the app pointed at a folder that is gone
        // would be the worse outcome.
        setError(`Could not re-link the library: ${e}`);
      }
    }
    onLibraryDirChange?.(dir);
  }, [libraryDir, onLibraryDirChange]);

  // Keep the library folder watcher pointed at the current dir and run an
  // incremental sync whenever it reports a change.
  useEffect(() => {
    if (!libraryDir) return;
    void startLibraryWatch(libraryDir);
    // This effect re-runs on every folder change, so the leak the group guards
    // against is not hypothetical here: switching folders quickly would leave a
    // watcher listener behind for each switch.
    const group = listenerGroup();
    // New files on disk get analyzed, then queued for their tempo.
    void onLibraryChanged(() => {
      void incrementalSync().then((synced) => backlogRef.current(synced));
    }).then((off) => group.add(off));
    return () => {
      group.dispose();
      void startLibraryWatch("");
    };
  }, [libraryDir, incrementalSync]);

  // No save effect: the backend persists the library itself. The scan writes
  // each batch as it produces it, and edits are written per change — so there
  // is nothing here to throttle, and nothing to lose on a quit.

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
        // A conversion re-embeds the cover, and an in-place one keeps the path,
        // which is exactly when a cached thumbnail outlives the file it shows.
        forgetCoverThumbs([...outputs, ...res.map((r) => r.source_path)]);
        if (outputs.length) {
          const analyzed = await analyzeFiles(
            outputs,
            false,
            libraryDir ?? undefined,
          );
          setTracks((prev) => mergeConverted(prev, res, analyzed));
          // Drop edits of sources that a format change replaced with a new path
          // (their metadata is now written into the freshly analyzed output).
          const replaced = res
            .filter(
              (r) => r.success && r.output_path && r.output_path !== r.source_path,
            )
            .map((r) => r.source_path);
          if (replaced.length) {
            setEdits((prev) => {
              let dirty = false;
              const next = { ...prev };
              for (const path of replaced) {
                if (next[path]) {
                  delete next[path];
                  dirty = true;
                }
              }
              return dirty ? next : prev;
            });
            void clearEdits(replaced);
          }
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
  // Not edit-aware, unlike the genres: the key is analysis state, so no pending
  // edit can change it.
  const keyOptions = useMemo(() => collectKeys(tracks), [tracks]);
  // The one list the header, the group rows and the track rows all iterate, so
  // a column cannot exist in one of them and not the others.
  const cols = useMemo(
    () => visibleColumns((settings.hidden_columns ?? []) as ColumnId[]),
    [settings.hidden_columns],
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

  // Playlists: the list, their contents, and every way of changing them.
  const playlists = usePlaylists();
  /** What is being dragged, and the row it is currently hovering in front of. */
  const [playlistDrag, setPlaylistDrag] = useState<{
    id: number;
    paths: string[];
  } | null>(null);
  const [dragOver, setDragOver] = useState<{ id: number; before: string } | null>(
    null,
  );

  // Dragging a row that is part of the selection moves the whole selection;
  // dragging an unselected row moves just that one, which is what every list
  // that does this behaves like.
  const playlistGroups = useMemo(
    () =>
      grouping === "playlist"
        ? buildPlaylistGroups(playlists.all, playlists.contents, visibleTracks)
        : null,
    [grouping, playlists.all, playlists.contents, visibleTracks],
  );

  // Label tree of the visible tracks (label -> album -> tracks).
  const labelRoot = useMemo(
    () =>
      grouping === "label"
        ? buildLabelTree(visibleTracks, edits, sortKey, sortDir)
        : null,
    [grouping, visibleTracks, edits, sortKey, sortDir],
  );

  // Flat render order (including collapsed) for the shift selection.
  const renderOrder = useMemo(() => {
    if (playlistGroups) return playlistGroups.flatMap((g) => g.tracks);
    if (folderRoot) return folderTrackList(folderRoot);
    if (labelRoot) return labelTrackList(labelRoot);
    if (!albumItems) return sortedFlat ?? visibleTracks;
    const arr: TrackAnalysis[] = [];
    for (const it of albumItems) {
      if (it.type === "group") arr.push(...it.tracks);
      else arr.push(it.track);
    }
    return arr;
  }, [playlistGroups, folderRoot, labelRoot, albumItems, sortedFlat, visibleTracks]);

  /**
   * The selected tracks' paths, in the order the table shows them — a playlist
   * built from a selection should come out in the order the user was looking
   * at, not in the order a `Set` happens to iterate.
   */
  const [exporting, setExporting] = useState(false);

  /**
   * Writes the Rekordbox collection, after asking where to put it.
   *
   * The count comes back from the backend rather than from the list on screen:
   * the export reads the database, so what it wrote is what it should report,
   * filter or no filter.
   */
  const runExport = useCallback(async () => {
    if (!libraryDir) return;
    setExporting(true);
    setError(null);
    try {
      // No confirmation of our own: the backend records the export in the event
      // log, which is where this app already says what it has done to the
      // library. A second notice next to the button would be the same sentence
      // twice, in the place people are least likely to look for it later.
      await exportRekordbox(libraryDir);
    } catch (e) {
      setError(`Could not write the export: ${e}`);
    } finally {
      setExporting(false);
    }
  }, [libraryDir]);

  const selectedPaths = useCallback(
    () => renderOrder.filter((t) => selected.has(t.id)).map((t) => t.path),
    [renderOrder, selected],
  );

  /**
   * What each playlist would gain from the current selection.
   *
   * Computed here rather than in the menu so the menu stays a renderer, and
   * eagerly rather than on open, because it is a set lookup per selected track
   * and the answer decides whether an entry is clickable at all.
   */
  const playlistGains = useMemo(() => {
    const paths = selectedPaths();
    const out: Record<number, number> = {};
    for (const p of playlists.all) {
      out[p.id] = wouldAdd(playlists.contents[p.id] ?? [], paths);
    }
    return out;
  }, [playlists.all, playlists.contents, selectedPaths]);

  const startPlaylistDrag = useCallback(
    (id: number, track: TrackAnalysis) => {
      const paths = selected.has(track.id) ? selectedPaths() : [track.path];
      setPlaylistDrag({ id, paths });
    },
    [selected, selectedPaths],
  );

  const dropPlaylistDrag = useCallback(
    async (before: string | null) => {
      const drag = playlistDrag;
      setPlaylistDrag(null);
      setDragOver(null);
      if (!drag) return;
      await playlists.move(drag.id, drag.paths, before);
    },
    [playlistDrag, playlists],
  );

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

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }, []);

  const toggleLabel = useCallback((id: string) => {
    setExpandedLabels((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

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
  const scanLabel = buildScanLabel(scanProgress);
  // Any pass of the scan, probing included — the button reports all of them.
  const scanRunning = !!scanProgress?.running;
  const scanPaused = !!scanProgress?.paused;
  const scanState = scanButtonState(scanRunning, scanFinished, scanPaused);

  // Whether the scan button shows what a click would do instead of what the
  // run is doing. Armed by pointer *movement* rather than by `:hover`: a click
  // leaves the pointer exactly where it was, so CSS would call that a hover and
  // flip the button to "Pause scan" the instant the run starts — swallowing the
  // one piece of feedback that says the click worked. Every change of run state
  // disarms it again, so the new status is always read first.
  const [showScanAction, setShowScanAction] = useState(false);
  useEffect(() => {
    setShowScanAction(false);
  }, [scanRunning, scanPaused]);

  // Let the confirmation fade after a moment — and drop it at once when the
  // next pass starts, so a running scan is never dressed as a finished one.
  useEffect(() => {
    if (!scanFinished) return;
    if (scanRunning) {
      setScanFinished(false);
      return;
    }
    const id = setTimeout(() => setScanFinished(false), SCAN_FINISHED_MS);
    return () => clearTimeout(id);
  }, [scanFinished, scanRunning]);


  // Tell the splash how far along we are. It comes down as soon as the list is
  // displayable — a first scan runs for minutes, and the table's own loading
  // state covers that far better than a splash would.
  useEffect(() => {
    if (!onBootPhase) return;
    if (!hydrated) return;
    if (tracks.length === 0 && !!libraryDir) {
      // A run is in progress and there is nothing to show yet, so the splash
      // stays and says which part.
      if (loading || scanProgress) {
        onBootPhase("scanning", scanProgress);
        return;
      }
      // The gap between the two: the sync is still diffing the folder, and the
      // scan it starts for the new files has not reported yet. Without this the
      // splash would come down for a moment and go straight back up.
      if (syncing) {
        onBootPhase("library");
        return;
      }
    }
    onBootPhase("ready");
  }, [
    onBootPhase,
    hydrated,
    syncing,
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

  // Re-reads which write can be undone next. Called after anything that writes
  // tags, so the button follows the backend's history rather than a second copy
  // of it kept here.
  const refreshUndo = useCallback(() => {
    void undoPeek()
      .then(setUndoEntry)
      .catch(() => setUndoEntry(null));
  }, []);

  useEffect(refreshUndo, [refreshUndo]);

  // Swaps the re-analyzed tracks into the list and clears the pending edits
  // they just persisted. A file that failed keeps its pending edit, so the
  // change isn't lost.
  const applyWriteResults = useCallback((results: WriteMetadataResult[]) => {
    setTracks((prev) => applyWrittenTracks(prev, results));
    // The row is re-analyzed above, but the thumbnail is drawn from its own
    // cache, which knows nothing about the write that just replaced or removed
    // the artwork. Undo comes through here too, and needs the same.
    forgetCoverThumbs(results.map((r) => r.path));
    const written = writtenIds(results);
    if (written.length) {
      setEdits((prev) => {
        const next = { ...prev };
        for (const id of written) delete next[id];
        return next;
      });
      void clearEdits(written);
    }
    const message = writeErrorMessage(results);
    if (message) setError(message);
  }, []);

  // Writes confirmed metadata straight into the files. The backend captures
  // their current tags first, under `label`, so the write stays undoable.
  const writeToFiles = useCallback(
    async (reqs: WriteMetadataItem[], label?: string) => {
      if (!reqs.length) return;
      setWriting(true);
      setError(null);
      try {
        applyWriteResults(await writeMetadata(reqs, true, label));
        refreshUndo();
      } catch (e) {
        setError(`Failed to write tags: ${e}`);
      } finally {
        setWriting(false);
      }
    },
    [applyWriteResults, refreshUndo],
  );

  // Take back the last tag write, restoring the files' previous on-disk state.
  const undoLastWrite = useCallback(async () => {
    setWriting(true);
    setError(null);
    try {
      applyWriteResults(await undoLast());
      refreshUndo();
    } catch (e) {
      setError(`Failed to undo: ${e}`);
    } finally {
      setWriting(false);
    }
  }, [applyWriteResults, refreshUndo]);

  const saveEdit = useCallback(
    (id: string, edit: TrackEdit) => {
      const track = tracks.find((t) => t.id === id);
      setEditingId(null);
      if (!track) return;
      // Show the edit immediately; the write re-analyzes and clears it.
      setEdits((prev) => ({ ...prev, [id]: edit }));
      // One row, written straight away — a pending edit must survive a quit
      // even though the tags are not on disk yet.
      void persistEdit(id, edit);
      void writeToFiles(
        [{ path: track.path, metadata: edit.metadata, cover: edit.cover }],
        track.file_name,
      );
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
      void writeToFiles(reqs, `bulk edit, ${reqs.length} track(s)`);
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
    void writeToFiles(reqs, `${reqs.length} pending edit(s)`);
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
  // Waving a group off has to outlast the next search: it runs with every scan
  // now, so a dismissal that only removed the group from the current result
  // would be handed straight back.
  const dismissDuplicateGroup = useCallback((id: string) => {
    void dismissDuplicates(id);
    setDupGroups((prev) => {
      const next = prev.filter((g) => g.id !== id);
      void saveDuplicates(next);
      return next;
    });
  }, []);

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
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });

  // Primary actions for the header.
  const headerActions = (
    <>
      {/* One button, two jobs. While nothing runs it starts a scan; while one
          runs it *is* the pause control, so the running state and the action it
          offers share the same place instead of competing for header space.
          The status shows at rest and the action once the pointer moves over it
          (or on keyboard focus) — both stacked in one grid cell, so the button
          is as wide as the wider of the two and does not resize under the
          pointer. */}
      <button
        onClick={() => (scanRunning ? void setScanPaused(!scanPaused) : void rescan())}
        onMouseMove={() => setShowScanAction(true)}
        onMouseLeave={() => setShowScanAction(false)}
        onFocus={(e) => {
          // Keyboard focus shows the action too, but only when it *is* keyboard
          // focus: a click focuses the button as well, and that is the case
          // this whole dance exists to keep quiet.
          if (e.currentTarget.matches(":focus-visible")) setShowScanAction(true);
        }}
        onBlur={() => setShowScanAction(false)}
        disabled={scanRunning ? false : converting || dedupeRunning}
        title={
          scanState === "paused"
            ? "Continue where the scan left off"
            : scanRunning
              ? "Hold the scan — whatever is being analyzed right now still finishes"
              : undefined
        }
        className={`h-9 justify-center inline-flex items-center gap-1.5 rounded-md border px-3 text-sm ${
 scanState === "finished"
 ? // "Done" is a state, so it takes the state colour — success, the
 // same green as the converted-track tick. Deliberately no
 // disabled: rule in this branch: a disabled: variant is a class
 // plus a pseudo-class and so outranks a bare status colour, which
 // left the label and icon grey inside an already-green outline
 // until the button happened to re-enable.
 "border-success-500 text-success-500"
 : "border-border-strong enabled:hover:border-accent-500 disabled:border-border disabled:text-fg-disabled"
 }`}
      >
        {scanRunning ? (
          <span className="grid">
            {/* Status. Spinner and stage share one muted wrapper, so they are
                the same grey as each other and as every other running
                indicator — regardless of whether the button happens to be
                disabled in this pass. That is what made "Analyzing" (disabled)
                and "Detecting BPM" (enabled) read as two different colours for
                the same kind of information. */}
            <span
              className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 text-fg-muted transition-opacity ${
                showScanAction ? "opacity-0" : "opacity-100"
              }`}
            >
              {scanState === "paused" ? <PauseIcon size={14} /> : <SpinnerIcon />}
              {scanLabel}
            </span>
            {/* Action. */}
            <span
              className={`col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 transition-opacity ${
                showScanAction ? "opacity-100" : "opacity-0"
              }`}
            >
              {scanState === "paused" ? (
                <>
                  <PlayIcon size={14} />
                  Resume scan
                </>
              ) : (
                <>
                  <PauseIcon size={14} />
                  Pause scan
                </>
              )}
            </span>
          </span>
        ) : scanState === "finished" ? (
          <span className="animate-fade-in inline-flex items-center gap-1.5">
            <CheckIcon />
            Scan finished
          </span>
        ) : (
          <>
            <ScanIcon />
            Scan library
          </>
        )}
      </button>
      {/* The incremental sync, left of the Duplicates button.
          Labelled, not a bare spinner. It appears unprompted — a file dropped
          into the folder in Finder starts it — so there is no action for a user
          to attribute it to, and an unattributable spinner between two buttons
          reads as belonging to neither. Same treatment the scan button and the
          pending-tags button already give their own status: icon plus what it
          is, in muted text. */}
      {syncing && !loading && (
        <span
          className="inline-flex items-center gap-1.5 px-1 text-sm text-fg-muted"
          title="Reconciling the library folder with what is stored"
        >
          <SpinnerIcon />
          Updating library…
        </span>
      )}
      {/* Purely a way into the result — the search itself is a scan phase now,
          so there is nothing to start here and nothing to show when the library
          is clean. */}
      {dupGroups.length > 0 && (
        <button
          onClick={() => setDupOpen(true)}
          disabled={converting}
          className="h-9 justify-center inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 text-sm enabled:hover:border-accent-500 disabled:border-border disabled:text-fg-disabled"
          title="Show the duplicate tracks found across all formats"
        >
          {`Duplicates (${dupGroups.length})`}
        </button>
      )}
      {skippedLabel(skipped) && (
        <button
          onClick={() => setSkippedOpen(true)}
          className="h-9 justify-center inline-flex items-center gap-1.5 rounded-md border border-warning-500/40 px-3 text-sm text-warning-500 hover:border-warning-500"
          title="Files the analysis could not use — see why"
        >
          {skippedLabel(skipped)}
        </button>
      )}
      {writing && (
        <span
          className="flex h-9 w-9 items-center justify-center text-fg-muted"
          title="Writing tags…"
          aria-label="Writing tags"
        >
          <SpinnerIcon />
        </span>
      )}
      {undoEntry && (
        <button
          onClick={() => void undoLastWrite()}
          disabled={writing}
          className="h-9 justify-center inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 text-sm enabled:hover:border-accent-500 disabled:border-border disabled:text-fg-disabled"
          title={`Undo the last tag write (${undoEntry.label})`}
        >
          <UndoIcon />
          Undo
        </button>
      )}
      {pendingEdits.length > 0 && (
        <button
          onClick={flushPendingEdits}
          disabled={writing || converting}
          className="h-9 justify-center inline-flex items-center gap-1.5 rounded-md border border-warning-500/40 px-3 text-sm text-warning-500 enabled:hover:border-warning-500 disabled:text-fg-disabled"
          title="Write metadata changes made earlier (not yet saved to the files) into the files"
        >
          {writing ? (
            // Same treatment as the scan button: while it runs, the content is
            // status rather than a warning-coloured label.
            <span className="inline-flex items-center gap-1.5 text-fg-muted">
              <SpinnerIcon />
              Write pending tags ({pendingEdits.length})
            </span>
          ) : (
            `Write pending tags (${pendingEdits.length})`
          )}
        </button>
      )}
      {selected.size > 0 && (
        <>
          <button
            onClick={() => setBulkOpen(true)}
            disabled={converting || writing}
            className="h-9 inline-flex items-center justify-center rounded-md border border-border-strong px-3 text-sm enabled:hover:border-accent-500 disabled:border-border disabled:text-fg-disabled"
          >
            Edit metadata ({selected.size})
          </button>
          <button
            onClick={convertSelected}
            disabled={converting}
            className="h-9 inline-flex items-center justify-center rounded-md bg-accent-600 px-4 text-sm font-medium enabled:hover:bg-accent-500 disabled:bg-surface-2 disabled:text-fg-disabled"
          >
            {converting ? "Converting…" : `Convert selection (${selected.size})`}
          </button>
          <AddToPlaylist
            playlists={playlists.all}
            gains={playlistGains}
            count={selected.size}
            disabled={converting || writing}
            onAdd={(id) => void playlists.add(id, selectedPaths())}
            onCreate={(name) => {
              void (async () => {
                const id = await playlists.create(name);
                if (id != null) await playlists.add(id, selectedPaths());
              })();
            }}
            suggestName={playlists.suggestName}
          />
          <button
            onClick={() =>
              void confirmAndDelete(
                tracks.filter((t) => selected.has(t.id)).map((t) => t.path),
                `Move ${selected.size} selected track(s) to the trash? Empty folders are removed too.`,
              )
            }
            disabled={converting}
            className="h-9 inline-flex items-center justify-center rounded-md border border-border-strong px-3 text-sm enabled:hover:border-danger-500 enabled:hover:text-danger-500 disabled:border-border disabled:text-fg-disabled"
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
              className="h-9 inline-flex items-center justify-center mt-2 rounded-md bg-accent-600 px-4 text-sm font-medium hover:bg-accent-500"
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

      {/* Without the sidecars nothing works: no analysis, no conversion, no
          BPM. Stated as an error rather than a warning, and never dismissed,
          because there is no partial mode to fall back to. */}
      {sidecarBroken && (
        <div className="mb-4 rounded-lg border border-danger-500/40 bg-danger-500/10 px-4 py-3 text-sm">
          <p className="text-danger-500">
            Audio tools unavailable — analysis and conversion cannot run
          </p>
          <p className="mt-0.5 break-all text-fg-muted">{sidecarBroken}</p>
          <p className="mt-1 font-sans text-fg-subtle">
            Re-installing the app usually fixes this.
          </p>
        </div>
      )}

      {/* The folder is configured but not there. A warning, not an error: the
          tracks are still in the database and nothing has been lost — the app
          just cannot see the files until the folder is pointed at again. */}
      {dirMissing && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-warning-500/40 bg-warning-500/10 px-4 py-3 text-sm">
          <div className="min-w-0">
            <p className="text-warning-500">Library folder not found</p>
            <p className="mt-0.5 truncate text-fg-muted" title={libraryDir}>
              {libraryDir}
            </p>
          </div>
          <button
            onClick={() => void relocateTo()}
            className="h-9 inline-flex items-center justify-center ml-auto shrink-0 rounded-md border border-border-strong px-3 hover:border-accent-500"
            title="Point the library at the folder's new location, keeping every track's edits and analysis"
          >
            Locate folder…
          </button>
        </div>
      )}

      {relocated && (
        <div className="mb-4 rounded-lg border border-border bg-surface px-4 py-2 text-sm text-fg-muted">
          {relocated}
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
          {/* Left: how the list is grouped, then how much of it is showing. */}
          <div className="flex shrink-0 items-center rounded-full ring-1 ring-border-strong">
            {GROUPINGS.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setGrouping(key)}
                className={`h-9 inline-flex items-center justify-center whitespace-nowrap rounded-full px-3 text-sm transition-colors ${
 grouping === key
 ? "bg-accent-600 text-fg"
 : "text-fg-muted hover:text-fg"
 }`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* ml-3 on top of the bar's gap-2 — 1.25rem, enough to read as a
              separate thing from the switch rather than part of it. */}
          <span className="ml-3 shrink-0 whitespace-nowrap text-sm text-fg-muted">
            {filtering
              ? `${visibleTracks.length} of ${counts.total} tracks`
              : `${counts.total} tracks`}
          </span>

          {/* Right: the active facets sit directly beside the button that set
              them, so the two read as one control. Chips grow leftwards from
              there and scroll once they run out of room.
              overflow-x forces overflow-y to compute as auto, which would clip
              their ring (a box-shadow, drawn outside the box). The negative
              margin buys it room without changing the bar's height. */}
          {/* Last in the row and pinned right, after the chips. Everything to
              the left of it refuses to shrink, so wherever it sat before, it
              was the thing that ran off the edge of a narrow window — while
              the chips beside it are the one element already built to scroll
              when the bar runs out of room. */}
          <button
            onClick={runExport}
            disabled={exporting || counts.total === 0}
            className="h-9 inline-flex items-center justify-center order-last ml-2 shrink-0 whitespace-nowrap rounded-md border border-border-strong px-3 text-sm enabled:hover:border-accent-500 disabled:border-border disabled:text-fg-disabled"
            title="Write a rekordbox.xml with every track, its tempo, key and beat grid, and the playlists"
          >
            {exporting ? "Exporting…" : "Export for Rekordbox"}
          </button>
          <div className="-my-1 ml-auto flex min-w-0 items-center justify-end gap-2 overflow-x-auto py-1">
            {activeChips.map((chip) => (
              <FilterChip
                key={chip.facet}
                label={chip.label}
                onRemove={() => setFilter(clearFacet(filter, chip.facet))}
              />
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ColumnMenu
              hidden={(settings.hidden_columns ?? []) as ColumnId[]}
              onChange={(hidden_columns) => onSettingsChange?.({ hidden_columns })}
            />
            <FilterMenu
              filter={filter}
              onChange={setFilter}
              genres={genreOptions}
              keys={keyOptions}
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
                {cols.map((c) =>
                  c.id === "select" ? (
                    <th key={c.id} className={`${c.width} px-4 py-3`}>
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAll}
                        className="h-4 w-4 rounded border-border-strong bg-surface-2"
                        aria-label="Select all"
                      />
                    </th>
                  ) : c.sortKey ? (
                    <SortableHeader
                      key={c.id}
                      label={c.label}
                      sortKey={c.sortKey}
                      activeKey={sortKey}
                      dir={sortDir}
                      onSort={toggleSort}
                      className={c.width}
                    />
                  ) : (
                    // Title is the column with no width: it absorbs the slack.
                    <th
                      key={c.id}
                      className={`${c.width ?? ""} ${
                        c.tight ? "px-1" : "px-4"
                      } py-3 font-medium`}
                    >
                      {c.label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody ref={bodyRef}>
              {(() => {
                /**
                 * One cell of a track row, chosen by column id.
                 *
                 * A switch rather than a table of render functions: the cells
                 * close over a dozen values from this scope (selection, the
                 * player, pending edits, conversion state) and hoisting them out
                 * would mean threading all of it through a parameter list.
                 */
                const trackCell = (
                  c: ColumnDef,
                  t: TrackAnalysis,
                  index: number,
                  depth: number,
                  md: TrackMetadata,
                  prog: ConvertProgress | undefined,
                  result: ConvertResult | undefined,
                  fromBandcamp: boolean,
                  /** Where the row sits in a playlist, when it is in one. */
                  inPlaylist?: { id: number; position: number; of: number },
                ): ReactNode => {
                  // `py-0`: the row's own `h-16` sets the height now, for every
                  // row in every grouping. Padding used to do it, and it could
                  // not — a cover is 40 px tall, a waveform 26, a line of text
                  // 20, so each kind of row came out its own height and the
                  // table stepped up and down as you scrolled through a folder.
                  const pad = "px-4 py-0";
                  switch (c.id) {
                    case "select":
                      // Never indented. Nesting is shown in the title column,
                      // the way the group headers do it — indenting this cell
                      // instead pushed the checkbox out of its 40 px column at
                      // depth 2, where it vanished behind the next one.
                      return (
                        <td key={c.id} className={pad} onClick={(e) => e.stopPropagation()}>
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
                      );
                    case "expand":
                      // A track has nothing to expand, so the cell exists to
                      // keep the columns aligned with the group rows above it —
                      // which makes it exactly the space a playlist position
                      // belongs in. In a playlist that number is what the row
                      // *is*, and it sits where the chevron would.
                      return (
                        <td
                          key={c.id}
                          className="px-1 text-right text-xs tabular-nums text-fg-subtle"
                        >
                          {inPlaylist?.position ?? ""}
                        </td>
                      );
                    case "cover":
                      return (
                        <td key={c.id} className={pad}>
                          <CoverThumb
                            path={t.path}
                            hasCover={t.metadata.has_cover}
                            onPlay={() => playFrom(renderOrder, index)}
                            active={player.current?.path === t.path}
                            playing={player.playing}
                            onToggle={player.toggle}
                          />
                        </td>
                      );
                    case "waveform":
                      return (
                        <td key={c.id} className={pad}>
                          <RowWaveform path={t.path} />
                        </td>
                      );
                    case "title":
                      // The indent lives here, matching the group headers, so
                      // one glance down the column shows the hierarchy and every
                      // checkbox above it stays in line.
                      return (
                        <td
                          key={c.id}
                          className={`${pad} text-fg`}
                          title={t.path}
                          style={depth ? { paddingLeft: 16 + depth * 20 } : undefined}
                        >
                          <MarqueeText text={md.title || t.file_name} />
                        </td>
                      );
                    case "artist":
                      return (
                        <td key={c.id} className={`max-w-[10rem] truncate ${pad} text-fg-muted`}>
                          {md.artist || "–"}
                        </td>
                      );
                    case "album":
                      return (
                        <td key={c.id} className={`max-w-[10rem] truncate ${pad} text-fg-muted`}>
                          {md.album || "–"}
                        </td>
                      );
                    case "length":
                      return (
                        <td key={c.id} className={`whitespace-nowrap ${pad} text-fg-muted`}>
                          {formatDuration(t.audio.duration_secs)}
                        </td>
                      );
                    case "bpm":
                      return (
                        <td
                          key={c.id}
                          className={`whitespace-nowrap ${pad} ${
                            bpmIsUncertain(t.bpm_confidence) ? "text-fg-warning" : "text-fg-muted"
                          }`}
                          title={
                            bpmIsUncertain(t.bpm_confidence)
                              ? "Detected, but not convincingly — this tempo was not written into the file"
                              : undefined
                          }
                        >
                          {formatBpm(md.bpm)}
                        </td>
                      );
                    case "key":
                      return (
                        <td
                          key={c.id}
                          className={`whitespace-nowrap ${pad} text-fg-muted`}
                          title={
                            t.key
                              ? `${keyDetail(t.key, t.key_camelot)} — detected, not written into the file${
                                  t.key_confidence != null
                                    ? `, ${Math.round(t.key_confidence * 100)}% sure`
                                    : ""
                                }`
                              : undefined
                          }
                        >
                          {formatKey(t.key)}
                        </td>
                      );
                    case "format":
                      return (
                        <td key={c.id} className={`truncate whitespace-nowrap ${pad} text-fg-muted`}>
                          {formatLabel(t.audio.codec, t.audio.container, t.audio.bits_per_sample)}
                          <span className="text-fg-subtle">
                            , {formatSampleRate(t.audio.sample_rate)}
                          </span>
                        </td>
                      );
                    case "downloaded":
                      return (
                        <td key={c.id} className={`whitespace-nowrap ${pad} text-fg-muted`}>
                          {formatDate(t.download_date)}
                        </td>
                      );
                    case "status":
                      return (
                        <td key={c.id} className={pad}>
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
                            <StatusIcons items={trackStatus(t, edits[t.id], fromBandcamp)} />
                          )}
                        </td>
                      );
                    case "actions":
                      return (
                        <td
                          key={c.id}
                          className={`relative ${pad}`}
                          onClick={(e) => e.stopPropagation()}
                        >
<div className="pointer-events-none absolute inset-y-0 right-4 flex items-center gap-2 rounded-lg bg-surface-2 pl-3 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                        {inPlaylist && (
                          <>
                            {/* The same move as the drag, by another road: a
                                drag is unusable once the target is off screen,
                                which on a 200-track set is most of the time. */}
                            <button
                              onClick={() => void playlists.step(inPlaylist.id, t.path, -1)}
                              disabled={inPlaylist.position === 1}
                              className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-accent-400 disabled:text-fg-disabled"
                              title="Move up in the playlist"
                              aria-label="Move up"
                            >
                              ↑
                            </button>
                            <button
                              onClick={() => void playlists.step(inPlaylist.id, t.path, 1)}
                              disabled={inPlaylist.position === inPlaylist.of}
                              className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-accent-400 disabled:text-fg-disabled"
                              title="Move down in the playlist"
                              aria-label="Move down"
                            >
                              ↓
                            </button>
                            <button
                              onClick={() =>
                                void playlists.removeTracks(inPlaylist.id, [t.path])
                              }
                              className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-danger-500"
                              title="Remove from this playlist (the file stays)"
                              aria-label="Remove from playlist"
                            >
                              −
                            </button>
                          </>
                        )}
                        {!t.compat.compatible && (
                          <button
                            onClick={() => convertOne(t)}
                            disabled={converting}
                            className="h-9 inline-flex items-center justify-center rounded-md bg-accent-600 px-2 text-xs font-medium enabled:hover:bg-accent-500 disabled:bg-surface-2 disabled:text-fg-disabled"
                            title="Convert to target format"
                          >
                            Convert
                          </button>
                        )}
                        <button
                          onClick={() => setEditingId(t.id)}
                          disabled={converting}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-accent-400 disabled:text-fg-disabled"
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
                          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-danger-500 disabled:text-fg-disabled"
                          title="Delete (move to trash)"
                          aria-label="Delete track"
                        >
                          <TrashIcon />
                        </button>
                      </div>
                        </td>
                      );
                  }
                };

                const renderTrackRow = (
                  t: TrackAnalysis,
                  index: number,
                  depth = 0,
                  /**
                   * Set only in the playlists grouping. It carries the place the
                   * row holds and makes it draggable — nowhere else is a row's
                   * order the user's to change, so nowhere else is it draggable.
                   */
                  inPlaylist?: { id: number; position: number; of: number },
                ) => {
                const prog = progress[t.id];
                const result = results[t.id];
                const fromBandcamp = !!originById[t.id];
                // Show confirmed edits in the list immediately.
                const md = edits[t.id]?.metadata ?? t.metadata;
                const dropHere =
                  inPlaylist &&
                  dragOver?.id === inPlaylist.id &&
                  dragOver.before === t.path;
                return (
                  <tr
                    // The same track may be in two playlists, and with both
                    // expanded it is two sibling rows. A bare `t.id` makes them
                    // one key, which React reconciles into one row — the drag
                    // handlers and the position cell then belong to whichever
                    // group won.
                    key={inPlaylist ? `${inPlaylist.id}:${t.id}` : t.id}
                    onClick={() => setEditingId(t.id)}
                    draggable={!!inPlaylist}
                    onDragStart={
                      inPlaylist
                        ? () => startPlaylistDrag(inPlaylist.id, t)
                        : undefined
                    }
                    onDragOver={
                      inPlaylist
                        ? (e) => {
                            e.preventDefault();
                            setDragOver({ id: inPlaylist.id, before: t.path });
                          }
                        : undefined
                    }
                    onDrop={
                      inPlaylist
                        ? (e) => {
                            e.preventDefault();
                            void dropPlaylistDrag(t.path);
                          }
                        : undefined
                    }
                    // A drag does not always end in a drop: Escape cancels it,
                    // and so does letting go anywhere else. Only the drop used
                    // to clear this, which left the accent line painted under a
                    // row and the lifted selection still held.
                    onDragEnd={
                      inPlaylist
                        ? () => {
                            setDragOver(null);
                            setPlaylistDrag(null);
                          }
                        : undefined
                    }
                    className={`group h-16 cursor-pointer border-b border-border last:border-0 hover:bg-surface-2 ${
                      dropHere ? "border-t-2 border-t-accent-500" : ""
                    }`}
                  >
                    {cols.map((c) =>
                      trackCell(
                        c,
                        t,
                        index,
                        depth,
                        md,
                        prog,
                        result,
                        fromBandcamp,
                        inPlaylist,
                      ),
                    )}
                  </tr>
                );
                };

                const rows: ReactNode[] = [];

                // Folder view: render the directory tree (folders + track leaves).
                // One header row for every kind of group (album, label, folder)
                // so a group shows the same columns everywhere. `cover` is only
                // passed where one artwork really represents the group.
                /** One cell of a group row, chosen by the same column list. */
                const groupCell = (
                  c: ColumnDef,
                  opts: {
                    id: string;
                    title: string;
                    depth: number;
                    tracks: TrackAnalysis[];
                    expanded: boolean;
                    onToggle: () => void;
                    cover?: TrackAnalysis;
                    albumText?: string;
                    actions?: ReactNode;
                  },
                  s: GroupSummary,
                  allSel: boolean,
                  someSel: boolean,
                  groupStatus: TrackStatus[],
                ): ReactNode => {
                  // Same height as a track row — see the note there.
                  const pad = "px-4 py-0";
                  const gTracks = opts.tracks;
                  switch (c.id) {
                    case "select":
                      return (
                        <td key={c.id} className={pad} onClick={(e) => e.stopPropagation()}>
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
                      );
                    case "expand":
                      // The chevron is its own column now, which is what lets
                      // the title carry the indent without pushing anything out
                      // of line. Narrow padding: `w-8` with `px-4` leaves no
                      // content box at all, and the icon disappeared.
                      return (
                        <td key={c.id} className="px-1 py-2.5">
                          <span className="flex justify-center text-fg-subtle">
                            <ChevronIcon open={opts.expanded} />
                          </span>
                        </td>
                      );
                    case "cover":
                      return (
                        <td key={c.id} className={pad}>
                          {opts.cover && (
                            <CoverThumb
                              path={opts.cover.path}
                              hasCover={opts.cover.metadata.has_cover}
                              onPlay={() => playFrom(gTracks, 0, true)}
                              active={gTracks.some((t) => t.path === player.current?.path)}
                              playing={player.playing}
                              onToggle={player.toggle}
                            />
                          )}
                        </td>
                      );
                    case "waveform":
                      // No waveform for a group: it would be a picture of
                      // several tracks at once, which is a picture of nothing.
                      return <td key={c.id} className={pad} />;
                    case "title":
                      return (
                        <td
                          key={c.id}
                          className={pad}
                          style={
                            opts.depth ? { paddingLeft: 16 + opts.depth * 20 } : undefined
                          }
                        >
                          <div className="flex items-center gap-2">
                            <MarqueeText
                              text={opts.title}
                              className="min-w-0 font-medium text-fg"
                            />
                            <span className="shrink-0 whitespace-nowrap pl-2 text-xs text-fg-subtle">
                              {s.count} tracks
                            </span>
                          </div>
                        </td>
                      );
                    case "artist":
                      return (
                        <td key={c.id} className={`max-w-[10rem] truncate ${pad} text-fg-muted`}>
                          {s.albumArtist || "–"}
                        </td>
                      );
                    case "album":
                      return (
                        <td key={c.id} className={`truncate ${pad} text-fg-muted`}>
                          {opts.albumText ?? albumsLabel(s.albums)}
                        </td>
                      );
                    case "length":
                      return (
                        <td key={c.id} className={`whitespace-nowrap ${pad} text-fg-muted`}>
                          {formatDuration(s.totalLength)}
                        </td>
                      );
                    case "bpm":
                      return (
                        <td key={c.id} className={`whitespace-nowrap ${pad} text-fg-muted`}>
                          {s.bpm}
                        </td>
                      );
                    case "key":
                      // An album is rarely one key, and a summary that averaged
                      // them would invent something.
                      return <td key={c.id} className={pad} />;
                    case "format":
                      return (
                        <td key={c.id} className={`truncate whitespace-nowrap ${pad} text-fg-muted`}>
                          {s.format}
                        </td>
                      );
                    case "downloaded":
                      return (
                        <td key={c.id} className={`whitespace-nowrap ${pad} text-fg-muted`}>
                          {formatDate(s.newestDate)}
                        </td>
                      );
                    case "status":
                      return (
                        <td key={c.id} className={pad}>
                          <StatusIcons
                            items={groupStatus}
                            counts={{ convert: s.needConvert, incomplete: s.needIncomplete }}
                          />
                        </td>
                      );
                    case "actions":
                      return (
                        <td
                          key={c.id}
                          className={`relative ${pad}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {opts.actions && (
                            <div className="pointer-events-none absolute inset-y-0 right-4 flex items-center gap-2 rounded-lg bg-surface-2 pl-3 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
                              {opts.actions}
                            </div>
                          )}
                        </td>
                      );
                  }
                };

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
                  const { tracks: gTracks } = opts;
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
                      className="group h-16 cursor-pointer border-b border-border bg-surface-2/40 hover:bg-surface-2"
                    >
                      {cols.map((c) =>
                        groupCell(c, opts, s, allSel, someSel, groupStatus),
                      )}
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
                          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-accent-400 disabled:text-fg-disabled"
                          title="Edit metadata for all tracks in this folder"
                          aria-label="Edit folder metadata"
                        >
                          <EditIcon />
                        </button>
                        <button
                          onClick={() => void confirmAndDeleteFolder(node)}
                          disabled={converting}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-danger-500 disabled:text-fg-disabled"
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
                        className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-accent-400 disabled:text-fg-disabled"
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
                          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-danger-500 disabled:text-fg-disabled"
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

                if (playlistGroups) {
                  const idxRef = { i: 0 };
                  for (const group of playlistGroups) {
                    const key = `playlist-${group.id}`;
                    const expanded = expandedLabels.has(key);
                    renderGroupHeader({
                      id: key,
                      title: group.playlist
                        ? group.name
                        : "Unsorted — not in any playlist",
                      depth: 0,
                      tracks: group.tracks,
                      expanded,
                      onToggle: () => toggleLabel(key),
                      actions: group.playlist ? (
                        <PlaylistMenu
                          playlist={group.playlist}
                          onRename={(name) =>
                            void playlists.rename(group.id, name)
                          }
                          onDelete={() => void playlists.remove(group.id)}
                        />
                      ) : undefined,
                    });
                    if (!expanded) {
                      idxRef.i += group.tracks.length;
                      continue;
                    }
                    group.tracks.forEach((t, i) => {
                      rows.push(
                        renderTrackRow(
                          t,
                          idxRef.i++,
                          1,
                          group.playlist
                            ? {
                                id: group.id,
                                // From the stored playlist, not from `i`: with
                                // a filter on, the row's place among what is
                                // visible is not its place in the list the
                                // buttons move it within.
                                position: group.positions[t.path] ?? i + 1,
                                of: group.of,
                              }
                            : undefined,
                        ),
                      );
                    });
                  }
                } else if (labelRoot) {
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
                          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-danger-500 disabled:text-fg-disabled"
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

      {skippedOpen && (
        <SkippedModal files={skipped} onClose={() => setSkippedOpen(false)} />
      )}

      {dupOpen && (
        <DuplicatesModal
          groups={dupGroups}
          onClose={() => setDupOpen(false)}
          onDeleteFiles={deleteFilesAndPrune}
          onDismissGroup={dismissDuplicateGroup}
        />
      )}
      </main>

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
    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-accent-600/20 py-0.5 pl-2.5 pr-1 text-xs text-accent-200 ring-1 ring-accent-500/40">
      {label}
      <button
        onClick={onRemove}
        className="flex h-4 w-4 items-center justify-center rounded-full text-accent-200/70 transition-colors hover:bg-accent-500/20 hover:text-accent-200"
        title={`Remove filter: ${label}`}
        aria-label={`Remove filter: ${label}`}
      >
        ✕
      </button>
    </span>
  );
}
