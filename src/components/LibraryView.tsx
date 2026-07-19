import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  bandcampCollection,
  bandcampDownload,
  cancelDedupe,
  cancelScan,
  convertTracks,
  dedupeStatus,
  onBandcampProgress,
  onConvertProgress,
  onDedupeDone,
  onDedupeProgress,
  onScanDone,
  onScanProgress,
  scanStatus,
  startDedupe,
  startScan,
} from "../lib/api";
import { loadLibrary, saveLibrary } from "../lib/library";
import {
  editComplete,
  formatBytes,
  formatDuration,
  formatSampleRate,
  trackBadges,
} from "../lib/format";
import { syncCollection, type SyncResult } from "../lib/bandcampSync";
import type { Settings } from "../lib/settings";
import type {
  BandcampAccount,
  BandcampItem,
  BandcampProgress,
  ConvertJob,
  ConvertOptions,
  ConvertProgress,
  ConvertResult,
  CoverInput,
  DedupeProgress,
  ScanProgress,
  TrackAnalysis,
  TrackEdit,
} from "../types";
import MetadataEditor from "./MetadataEditor";
import BulkMetadataEditor, { type BulkPatch } from "./BulkMetadataEditor";
import CoverThumb from "./CoverThumb";
import DuplicatesModal from "./DuplicatesModal";
import AppHeader from "./AppHeader";
import { ArrowUpIcon, DownloadIcon, EditIcon, GearIcon } from "./icons";
import { useScrolled } from "../lib/useScrolled";

interface Props {
  settings: Settings;
  account: BandcampAccount | null;
  onOpenSettings: () => void;
}

type DlState = "idle" | "loading" | "done" | "error";

type Filter = "all" | "convert" | "incomplete";

interface DownloadEntry {
  key: string;
  title: string;
  band: string;
  state: "loading" | "done" | "error";
  downloaded: number;
  total: number;
  stage: string;
  error?: string;
}

export default function LibraryView({ settings, account, onOpenSettings }: Props) {
  const [tracks, setTracks] = useState<TrackAnalysis[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [converting, setConverting] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [dedupeProgress, setDedupeProgress] = useState<DedupeProgress | null>(null);
  const [dedupeRunning, setDedupeRunning] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<Record<string, ConvertProgress>>({});
  const [results, setResults] = useState<Record<string, ConvertResult>>({});
  const [edits, setEdits] = useState<Record<string, TrackEdit>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [missingDismissed, setMissingDismissed] = useState(false);
  const [dl, setDl] = useState<Record<string, DlState>>({});
  const [downloads, setDownloads] = useState<Record<string, DownloadEntry>>({});
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const libraryDir = settings.library_dir;
  // Erst persistieren, nachdem der Cache geladen wurde – sonst überschreibt der
  // initiale (leere) State den gespeicherten Stand beim Mount.
  const hydratedRef = useRef(false);

  // Startet einen (Hintergrund-)Scan. Läuft bereits einer, dockt die UI nur an.
  const rescan = useCallback(async () => {
    if (!libraryDir) {
      setTracks([]);
      return;
    }
    setError(null);
    setLoading(true);
    void startScan(libraryDir);
  }, [libraryDir]);

  // Persistente Scan-Listener (einmalig): Fortschritt + Ergebnis.
  useEffect(() => {
    let unProg: (() => void) | undefined;
    let unDone: (() => void) | undefined;
    void (async () => {
      unProg = await onScanProgress((p) => {
        setScanProgress(p);
        setLoading(p.running);
      });
      unDone = await onScanDone((d) => {
        setLoading(false);
        if (!d.cancelled) setTracks(d.tracks);
      });
    })();
    return () => {
      unProg?.();
      unDone?.();
    };
  }, []);

  // Persistente Dedupe-Listener: Fortschritt (in dieselbe Leiste) + Abschluss.
  useEffect(() => {
    let unProg: (() => void) | undefined;
    let unDone: (() => void) | undefined;
    void (async () => {
      unProg = await onDedupeProgress((p) => {
        setDedupeProgress(p);
        setDedupeRunning(p.running);
      });
      unDone = await onDedupeDone((d) => {
        setDedupeRunning(false);
        // Bei Erfolg (auch ohne Treffer) die Ergebnisse anzeigen.
        if (!d.cancelled) setDupOpen(true);
      });
    })();
    return () => {
      unProg?.();
      unDone?.();
    };
  }, []);

  // Persistenter Bandcamp-Download-Fortschritt (für das Downloads-Overlay).
  useEffect(() => {
    let unProg: (() => void) | undefined;
    void (async () => {
      unProg = await onBandcampProgress((p: BandcampProgress) => {
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
    return () => unProg?.();
  }, []);

  // Beim Start / Ordnerwechsel: zwischengespeicherte Liste sofort anzeigen,
  // dann an einen laufenden Scan andocken oder einen neuen (Hintergrund-)Scan
  // starten. Die Liste bleibt dabei sichtbar.
  useEffect(() => {
    let active = true;
    hydratedRef.current = false;
    void (async () => {
      const cache = await loadLibrary();
      if (active && cache && cache.library_dir === libraryDir) {
        setTracks(cache.tracks);
        setEdits(cache.edits ?? {});
      }
      // Ab jetzt darf persistiert werden (Cache wurde berücksichtigt).
      hydratedRef.current = true;
      if (!active || !libraryDir) return;
      const status = await scanStatus();
      if (!active) return;
      if (status.running) {
        // An laufenden Scan andocken statt neu zu starten.
        setLoading(true);
        setScanProgress({
          generation: status.generation,
          done: status.done,
          total: status.total,
          running: true,
        });
      } else {
        await rescan();
      }
    })();
    return () => {
      active = false;
    };
  }, [libraryDir, rescan]);

  // Track-Datenbank persistent halten (erst nach der Hydration, damit der
  // initiale leere State den Cache nicht überschreibt).
  useEffect(() => {
    if (!libraryDir || !hydratedRef.current) return;
    void saveLibrary({ library_dir: libraryDir, tracks, edits });
  }, [libraryDir, tracks, edits]);

  // Konvertierungsaufträge ausführen.
  // - "library": Quelle liegt schon in der Library -> Ausgabe in denselben
  //   Ordner (output_dir=null) und Original nach Formatwechsel löschen.
  // - "import": externe Datei -> in die Library kopieren, Original behalten.
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
            `${failed.length} Datei(en) fehlgeschlagen: ${failed
              .map((f) => f.error)
              .filter(Boolean)
              .join("; ")}`,
          );
        }
        // Progress stoppen -> "✓ Fertig" pro Zeile zeigen, kurz stehen lassen,
        // dann (bei Bulk erst wenn alle fertig sind) die Liste aktualisieren.
        unlisten();
        setConverting(false);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        setSelected(new Set());
        setProgress({});
        setResults({});
        await rescan();
      } catch (e) {
        unlisten();
        setConverting(false);
        setError(`Konvertierung fehlgeschlagen: ${e}`);
      }
    },
    [settings, libraryDir, rescan],
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

  // Drag & Drop: Dateien in die Library konvertieren.
  const importPaths = useCallback(
    async (paths: string[]) => {
      if (!libraryDir) {
        setError("Bitte zuerst einen Library-Ordner in den Einstellungen wählen.");
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

  // Bandcamp-Abgleich.
  const runSync = useCallback(async () => {
    if (!account) return;
    setSyncing(true);
    setError(null);
    try {
      const items = await bandcampCollection();
      setSync(syncCollection(tracks, items));
      setMissingDismissed(false);
    } catch (e) {
      setError(`Abgleich fehlgeschlagen: ${e}`);
    } finally {
      setSyncing(false);
    }
  }, [account, tracks]);

  const downloadMissing = useCallback(
    async (item: BandcampItem) => {
      if (!item.download_page_url || !libraryDir) return;
      setDl((s) => ({ ...s, [item.key]: "loading" }));
      setDownloads((s) => ({
        ...s,
        [item.key]: {
          key: item.key,
          title: item.title,
          band: item.band_name,
          state: "loading",
          downloaded: 0,
          total: 0,
          stage: "Lädt",
        },
      }));
      setDownloadsOpen(true);
      const finish = (patch: Partial<DownloadEntry>) =>
        setDownloads((s) =>
          s[item.key] ? { ...s, [item.key]: { ...s[item.key], ...patch } } : s,
        );
      try {
        const res = await bandcampDownload(
          item.key,
          item.download_page_url,
          libraryDir,
        );
        if (res.success) {
          setDl((s) => ({ ...s, [item.key]: "done" }));
          finish({ state: "done", stage: "Fertig" });
          await rescan();
        } else {
          setDl((s) => ({ ...s, [item.key]: "error" }));
          finish({ state: "error", error: res.error ?? "Download fehlgeschlagen" });
          setError(res.error ?? "Download fehlgeschlagen");
        }
      } catch (e) {
        setDl((s) => ({ ...s, [item.key]: "error" }));
        finish({ state: "error", error: String(e) });
        setError(String(e));
      }
    },
    [libraryDir, rescan],
  );

  // Anker für die Shift-Bereichsauswahl (Index in visibleTracks) und die
  // Auswahl zum Anker-Zeitpunkt (Basis, auf die der Shift-Bereich angewandt wird).
  const anchorIndexRef = useRef<number | null>(null);
  const baseSelectionRef = useRef<Set<string>>(new Set());

  // Ist ein Track (unter Berücksichtigung offener Edits) unvollständig?
  const isIncomplete = useCallback(
    (t: TrackAnalysis) => {
      const edit = edits[t.id];
      return edit ? !editComplete(edit) : t.metadata_incomplete;
    },
    [edits],
  );

  // Sichtbare Tracks gemäß Filter + Suche.
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

  // Zeilenauswahl mit Shift-Bereichsauswahl (klassisch wie im Datei-Explorer).
  const handleRowSelect = useCallback(
    (index: number, shiftKey: boolean) => {
      const id = visibleTracks[index]?.id;
      if (!id) return;

      if (shiftKey && anchorIndexRef.current !== null) {
        // Bereich neu setzen: Basis + aktueller Anker-Bereich. Zeilen, die zu
        // einem früheren (größeren) Bereich gehörten, fallen so wieder weg.
        const start = Math.min(anchorIndexRef.current, index);
        const end = Math.max(anchorIndexRef.current, index);
        setSelected(() => {
          const next = new Set(baseSelectionRef.current);
          for (let i = start; i <= end; i++) {
            const rid = visibleTracks[i]?.id;
            if (rid) next.add(rid);
          }
          return next;
        });
      } else {
        // Normaler Klick: einzeln togglen, Anker + Basis neu festlegen.
        setSelected((prev) => {
          const next = new Set(prev);
          next.has(id) ? next.delete(id) : next.add(id);
          baseSelectionRef.current = new Set(next);
          return next;
        });
        anchorIndexRef.current = index;
      }
    },
    [visibleTracks],
  );

  const saveEdit = useCallback((id: string, edit: TrackEdit) => {
    setEdits((prev) => ({ ...prev, [id]: edit }));
    setEditingId(null);
  }, []);

  // Bulk-Edit: gewählte Felder auf alle selektierten Tracks anwenden.
  const applyBulk = useCallback(
    (patch: BulkPatch) => {
      setEdits((prev) => {
        const next = { ...prev };
        tracks.forEach((t) => {
          if (!selected.has(t.id)) return;
          const base = prev[t.id]?.metadata ?? t.metadata;
          const cover: CoverInput =
            prev[t.id]?.cover ??
            (t.metadata.has_cover ? { kind: "keep" } : { kind: "none" });
          next[t.id] = { metadata: { ...base, ...patch }, cover };
        });
        return next;
      });
      setBulkOpen(false);
    },
    [tracks, selected],
  );

  // Nach dem Verschieben von Duplikaten in den Papierkorb.
  const handleDuplicatesDeleted = useCallback(
    (paths: string[]) => {
      const gone = new Set(paths);
      setTracks((prev) => prev.filter((t) => !gone.has(t.path)));
      setSelected((prev) => {
        const next = new Set(prev);
        paths.forEach((p) => next.delete(p));
        return next;
      });
      setDupOpen(false);
      void rescan();
    },
    [rescan],
  );

  // Duplikatsuche starten (läuft im Hintergrund, Fortschritt in der Scan-Leiste).
  const findDuplicates = useCallback(async () => {
    const status = await dedupeStatus();
    if (status.running) return; // läuft bereits – Leiste zeigt Fortschritt
    if (status.has_result) {
      setDupOpen(true); // fertiges Ergebnis direkt zeigen
      return;
    }
    const candidates = tracks.map((t) => ({
      id: t.id,
      path: t.path,
      name: edits[t.id]?.metadata.title || t.metadata.title || t.file_name,
      codec: t.audio.codec,
      container: t.audio.container,
      sample_rate: t.audio.sample_rate,
      bits_per_sample: t.audio.bits_per_sample,
      lossless: t.audio.lossless,
      duration_secs: t.audio.duration_secs,
      compatible: t.compat.compatible,
    }));
    void startDedupe(candidates);
  }, [tracks, edits]);

  // Vorhandene Werte je Feld als Auswahl-Vorschläge (aus Tracks + Edits).
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
    } as Record<string, string[]>;
  }, [tracks, edits]);

  // Sticky-„Andock"-Animation + Back-to-Top.
  const scrolled = useScrolled(4);
  const showTop = useScrolled(400);
  const scrollToTop = () => window.scrollTo({ top: 0, behavior: "smooth" });

  // Eine Leiste für beide Hintergrund-Jobs (Scan & Duplikatsuche).
  const scanPct =
    scanProgress && scanProgress.total > 0
      ? Math.round((scanProgress.done / scanProgress.total) * 100)
      : 0;
  const dedupePct =
    dedupeProgress && dedupeProgress.total > 0
      ? Math.round((dedupeProgress.done / dedupeProgress.total) * 100)
      : 0;
  const showBar = loading || dedupeRunning;
  const progressBar = dedupeRunning
    ? {
        label:
          dedupeProgress?.stage === "Vergleiche"
            ? "Vergleiche Fingerabdrücke…"
            : "Suche Duplikate…",
        done: dedupeProgress?.done ?? 0,
        total: dedupeProgress?.total ?? 0,
        pct: dedupePct,
        cancel: () => void cancelDedupe(),
      }
    : {
        label: "Scanne Library…",
        done: scanProgress?.done ?? 0,
        total: scanProgress?.total ?? 0,
        pct: scanPct,
        cancel: () => void cancelScan(),
      };

  // Downloads-Overlay (Bandcamp) – Chrome-artiges Icon mit Fortschritt.
  const downloadList = Object.values(downloads);
  const activeDownloads = downloadList.filter((d) => d.state === "loading").length;
  const clearFinishedDownloads = () =>
    setDownloads((s) =>
      Object.fromEntries(
        Object.entries(s).filter(([, d]) => d.state === "loading"),
      ),
    );

  const downloadsButton = downloadList.length > 0 && (
    <div className="relative shrink-0">
      <button
        onClick={() => setDownloadsOpen((o) => !o)}
        className="relative flex items-center justify-center rounded-lg border border-border-strong p-2 text-fg-muted hover:border-accent-500 hover:text-accent-400"
        title="Downloads"
        aria-label="Downloads"
      >
        <DownloadIcon />
        {activeDownloads > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-600 px-1 text-[10px] font-medium text-white">
            {activeDownloads}
          </span>
        )}
      </button>
      {downloadsOpen && (
        <div className="absolute right-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-lg shadow-black/40">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <span className="text-xs font-medium text-fg-muted">Downloads</span>
            <div className="flex items-center gap-2">
              {downloadList.some((d) => d.state !== "loading") && (
                <button
                  onClick={clearFinishedDownloads}
                  className="text-xs text-fg-subtle hover:text-fg"
                >
                  Aufräumen
                </button>
              )}
              <button
                onClick={() => setDownloadsOpen(false)}
                className="text-fg-subtle hover:text-fg"
                aria-label="Schließen"
              >
                ✕
              </button>
            </div>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {downloadList.map((d) => {
              const pct =
                d.total > 0 ? Math.round((d.downloaded / d.total) * 100) : 0;
              return (
                <div key={d.key} className="border-b border-border/60 px-3 py-2 last:border-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-fg" title={d.title}>
                      {d.title}
                    </span>
                    <span className="shrink-0 text-xs text-fg-subtle">
                      {d.state === "done"
                        ? "✓ Fertig"
                        : d.state === "error"
                          ? "Fehler"
                          : d.total > 0
                            ? `${pct}%`
                            : d.stage}
                    </span>
                  </div>
                  {d.band && (
                    <p className="truncate text-xs text-fg-subtle">{d.band}</p>
                  )}
                  {d.state === "loading" && (
                    <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                      <div
                        className={`h-full rounded-full bg-accent-500 transition-all duration-300 ${
                          d.total > 0 ? "" : "animate-pulse w-1/3"
                        }`}
                        style={d.total > 0 ? { width: `${pct}%` } : undefined}
                      />
                    </div>
                  )}
                  {d.state === "loading" && d.total > 0 && (
                    <p className="mt-1 text-[11px] text-fg-subtle">
                      {formatBytes(d.downloaded)} / {formatBytes(d.total)} ·{" "}
                      {d.stage}
                    </p>
                  )}
                  {d.state === "error" && d.error && (
                    <p className="mt-1 truncate text-[11px] text-danger-500" title={d.error}>
                      {d.error}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  const gearButton = (
    <button
      onClick={onOpenSettings}
      className="shrink-0 rounded-lg border border-border-strong p-2 text-fg-muted hover:border-accent-500 hover:text-accent-400"
      title="Einstellungen"
      aria-label="Einstellungen"
    >
      <GearIcon />
    </button>
  );

  // Primäre Aktionen für den Header.
  const headerActions = (
    <>
      <button
        onClick={() => void rescan()}
        disabled={loading || converting || dedupeRunning}
        className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:border-accent-500 disabled:opacity-50"
      >
        {loading ? "Scanne…" : "Neu scannen"}
      </button>
      <button
        onClick={() => void runSync()}
        disabled={!account || syncing || loading}
        className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:border-accent-500 disabled:opacity-50"
        title={
          account
            ? "Library mit Bandcamp-Sammlung abgleichen"
            : "In den Einstellungen mit Bandcamp verbinden"
        }
      >
        {syncing ? "Gleiche ab…" : "Mit Bandcamp abgleichen"}
      </button>
      <button
        onClick={() => void findDuplicates()}
        disabled={loading || converting || dedupeRunning || tracks.length < 2}
        className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:border-warning-500 disabled:opacity-50"
        title="Doppelte Tracks über alle Formate finden"
      >
        {dedupeRunning ? "Suche Duplikate…" : "Duplikate suchen"}
      </button>
      {selected.size > 0 && (
        <>
          <button
            onClick={() => setBulkOpen(true)}
            disabled={converting}
            className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:border-accent-500 disabled:opacity-50"
          >
            Metadaten bearbeiten ({selected.size})
          </button>
          <button
            onClick={convertSelected}
            disabled={converting}
            className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium hover:bg-accent-500 disabled:opacity-50"
          >
            {converting ? "Konvertiere…" : `Auswahl konvertieren (${selected.size})`}
          </button>
        </>
      )}
      {downloadsButton}
      {gearButton}
    </>
  );

  // ---- Empty states ----
  if (!libraryDir) {
    return (
      <>
        <AppHeader onTitleClick={scrollToTop} right={gearButton} />
        <main className="mx-auto max-w-6xl px-6 py-16">
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-surface py-20 text-center text-fg-subtle">
            <p className="text-lg text-fg-muted">Kein Library-Ordner gewählt</p>
            <p className="text-sm">
              Lege in den Einstellungen fest, wo deine Sammlung liegt.
            </p>
            <button
              onClick={onOpenSettings}
              className="mt-2 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium hover:bg-accent-500"
            >
              Einstellungen öffnen
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
      {/* Fortschritt (Scan & Duplikatsuche): scrollt mit und verschwindet. */}
      <div
        className={`overflow-hidden transition-all duration-500 ease-out ${
          showBar ? "mb-4 max-h-24 opacity-100" : "mb-0 max-h-0 opacity-0"
        }`}
      >
        <div className="rounded-lg border border-border bg-surface px-4 py-3">
          <div className="mb-2 flex items-center gap-3 text-sm">
            <span className="text-fg-muted">{progressBar.label}</span>
            <span className="text-fg-subtle">
              {progressBar.total > 0
                ? `${progressBar.done} / ${progressBar.total}`
                : ""}
            </span>
            <button
              onClick={progressBar.cancel}
              className="ml-auto rounded-md border border-border-strong px-2 py-0.5 text-xs text-fg-muted hover:border-danger-500 hover:text-danger-500"
            >
              Abbrechen
            </button>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full bg-accent-500 transition-all duration-300 ease-out"
              style={{ width: `${progressBar.pct}%` }}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-danger-500/30 bg-danger-500/10 px-4 py-2 text-sm text-danger-500">
          {error}
        </div>
      )}

      {/* Fehlt in Library */}
      {sync && sync.missing.length > 0 && !missingDismissed && (
        <section className="mb-6 rounded-xl border border-accent-500/30 bg-accent-500/5 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-accent-300">
              Fehlt in Library ({sync.missing.length})
            </h2>
            <button
              onClick={() => setMissingDismissed(true)}
              className="flex h-7 w-7 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-fg"
              title="Schließen"
              aria-label="Schließen"
            >
              ✕
            </button>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {sync.missing.map((item) => {
              const state = dl[item.key] ?? "idle";
              return (
                <div
                  key={item.key}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2"
                >
                  {item.art_url ? (
                    <img
                      src={item.art_url}
                      className="h-12 w-12 shrink-0 rounded object-cover"
                      alt=""
                    />
                  ) : (
                    <div className="h-12 w-12 shrink-0 rounded bg-surface-2" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg" title={item.title}>
                      {item.title}
                    </p>
                    <p className="truncate text-xs text-fg-subtle">
                      {item.band_name}
                    </p>
                  </div>
                  <button
                    onClick={() => void downloadMissing(item)}
                    disabled={!item.download_page_url || state === "loading"}
                    className="shrink-0 rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium hover:bg-accent-500 disabled:opacity-40"
                  >
                    {state === "loading"
                      ? "Lädt…"
                      : state === "done"
                        ? "✓ Geladen"
                        : state === "error"
                          ? "Fehler"
                          : "Laden"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Filterleiste (sticky unter dem Header) */}
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
            label={`Alle (${tracks.length})`}
          />
          <FilterChip
            active={filter === "convert"}
            onClick={() => setFilter("convert")}
            label={`Zu konvertieren (${
              tracks.filter((t) => !t.compat.compatible).length
            })`}
          />
          <FilterChip
            active={filter === "incomplete"}
            onClick={() => setFilter("incomplete")}
            label={`Metadaten unvollständig (${tracks.filter(isIncomplete).length})`}
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Suchen…"
            className="ml-auto w-56 rounded-lg border border-border-strong bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-accent-500"
          />
        </div>
      )}

      {/* Track-Liste / Drop-Zone */}
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
              {loading ? "Scanne Library…" : "Noch keine Musik in der Library"}
            </p>
            {!loading && (
              <p className="text-sm">
                Zieh Dateien hierher – sie werden in die Library konvertiert.
              </p>
            )}
          </div>
        ) : visibleTracks.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-fg-subtle">
            <p className="text-sm">Keine Titel passen zum Filter.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[60rem] text-sm">
            <thead className="text-left text-fg-muted">
              <tr className="border-b border-border">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-border-strong bg-surface-2"
                    aria-label="Alle auswählen"
                  />
                </th>
                <th className="w-14 px-4 py-3"></th>
                <th className="px-4 py-3 font-medium">Titel</th>
                <th className="w-40 px-4 py-3 font-medium">Artist</th>
                <th className="w-40 px-4 py-3 font-medium">Album</th>
                <th className="w-44 px-4 py-3 font-medium">Format</th>
                <th className="w-20 px-4 py-3 font-medium">Länge</th>
                <th className="w-56 px-4 py-3 font-medium">Status</th>
                <th className="w-28 px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {visibleTracks.map((t, index) => {
                const prog = progress[t.id];
                const result = results[t.id];
                const fromBandcamp = !!sync?.originById[t.id];
                // Bestätigte Edits sofort in der Liste anzeigen.
                const md = edits[t.id]?.metadata ?? t.metadata;
                return (
                  <tr
                    key={t.id}
                    onClick={() => setEditingId(t.id)}
                    className="cursor-pointer border-b border-border last:border-0 hover:bg-surface-2"
                  >
                    <td
                      className="px-4 py-3"
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
                        aria-label={`${t.file_name} auswählen`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <CoverThumb path={t.path} hasCover={t.metadata.has_cover} />
                    </td>
                    <td
                      className="max-w-xs truncate px-4 py-3 text-fg"
                      title={t.path}
                    >
                      {md.title || t.file_name}
                    </td>
                    <td className="max-w-[10rem] truncate px-4 py-3 text-fg-muted">
                      {md.artist || "–"}
                    </td>
                    <td className="max-w-[10rem] truncate px-4 py-3 text-fg-muted">
                      {md.album || "–"}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-fg-muted">
                      {t.audio.codec.toUpperCase()}
                      <span className="text-fg-subtle">
                        {" "}
                        · {formatSampleRate(t.audio.sample_rate)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-fg-muted">
                      {formatDuration(t.audio.duration_secs)}
                    </td>
                    <td className="px-4 py-3">
                      {result ? (
                        result.success ? (
                          <span className="text-success-500">✓ Fertig</span>
                        ) : (
                          <span className="text-danger-500" title={result.error ?? ""}>
                            ✕ Fehler
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
                    <td
                      className="px-4 py-3 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center justify-end gap-2">
                        {!t.compat.compatible && (
                          <button
                            onClick={() => convertOne(t)}
                            disabled={converting}
                            className="rounded-md bg-accent-600 px-2 py-1 text-xs font-medium hover:bg-accent-500 disabled:opacity-40"
                            title="In Zielformat konvertieren"
                          >
                            Konvertieren
                          </button>
                        )}
                        <button
                          onClick={() => setEditingId(t.id)}
                          disabled={converting}
                          className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-accent-400 disabled:opacity-40"
                          title="Metadaten bearbeiten"
                          aria-label="Metadaten bearbeiten"
                        >
                          <EditIcon />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
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
          count={selected.size}
          suggestions={fieldOptions}
          onClose={() => setBulkOpen(false)}
          onApply={applyBulk}
        />
      )}

      {dupOpen && (
        <DuplicatesModal
          onClose={() => setDupOpen(false)}
          onDeleted={handleDuplicatesDeleted}
        />
      )}
      </main>

      {/* Back-to-Top */}
      <button
        onClick={scrollToTop}
        aria-label="Nach oben"
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
