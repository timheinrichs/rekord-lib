import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  bandcampCollection,
  bandcampDownload,
  cancelDedupe,
  cancelScan,
  convertTracks,
  dedupeStatus,
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
  formatDuration,
  formatSampleRate,
  trackBadges,
} from "../lib/format";
import { syncCollection, type SyncResult } from "../lib/bandcampSync";
import type { Settings } from "../lib/settings";
import type {
  BandcampAccount,
  BandcampItem,
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

interface Props {
  settings: Settings;
  account: BandcampAccount | null;
  onOpenSettings: () => void;
}

type DlState = "idle" | "loading" | "done" | "error";

type Filter = "all" | "convert" | "incomplete";

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
  const [dl, setDl] = useState<Record<string, DlState>>({});
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

  // Konvertierungsaufträge ausführen (Ausgabe in die Library).
  const runConvert = useCallback(
    async (jobs: ConvertJob[]) => {
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
          output_dir: libraryDir,
          sanitize_filenames: settings.sanitize_filenames,
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
      await runConvert(jobs);
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
      try {
        const res = await bandcampDownload(
          item.key,
          item.download_page_url,
          libraryDir,
        );
        if (res.success) {
          setDl((s) => ({ ...s, [item.key]: "done" }));
          await rescan();
        } else {
          setDl((s) => ({ ...s, [item.key]: "error" }));
          setError(res.error ?? "Download fehlgeschlagen");
        }
      } catch (e) {
        setDl((s) => ({ ...s, [item.key]: "error" }));
        setError(String(e));
      }
    },
    [libraryDir, rescan],
  );

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

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
      codec: t.audio.codec,
      container: t.audio.container,
      sample_rate: t.audio.sample_rate,
      bits_per_sample: t.audio.bits_per_sample,
      lossless: t.audio.lossless,
      duration_secs: t.audio.duration_secs,
      compatible: t.compat.compatible,
    }));
    void startDedupe(candidates);
  }, [tracks]);

  const stats = useMemo(() => {
    const needConvert = visibleTracks.filter((t) => !t.compat.compatible).length;
    const incomplete = visibleTracks.filter(isIncomplete).length;
    return { total: visibleTracks.length, needConvert, incomplete };
  }, [visibleTracks, isIncomplete]);

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

  // ---- Empty states ----
  if (!libraryDir) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-16">
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-800 bg-neutral-900/20 py-20 text-center text-neutral-500">
          <p className="text-lg text-neutral-300">Kein Library-Ordner gewählt</p>
          <p className="text-sm">
            Lege in den Einstellungen fest, wo deine Sammlung liegt.
          </p>
          <button
            onClick={onOpenSettings}
            className="mt-2 rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500"
          >
            Einstellungen öffnen
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="w-full px-6 py-6">
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => void rescan()}
          disabled={loading || converting || dedupeRunning}
          className="rounded-lg border border-neutral-700 px-3 py-2 text-sm hover:border-sky-500 disabled:opacity-50"
        >
          {loading ? "Scanne…" : "Neu scannen"}
        </button>
        <button
          onClick={() => void runSync()}
          disabled={!account || syncing || loading}
          className="rounded-lg border border-neutral-700 px-3 py-2 text-sm hover:border-teal-500 disabled:opacity-50"
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
          className="rounded-lg border border-neutral-700 px-3 py-2 text-sm hover:border-fuchsia-500 disabled:opacity-50"
          title="Doppelte Tracks über alle Formate finden"
        >
          {dedupeRunning ? "Suche Duplikate…" : "Duplikate suchen"}
        </button>
        {selected.size > 0 && (
          <>
            <button
              onClick={() => setBulkOpen(true)}
              disabled={converting}
              className="rounded-lg border border-neutral-700 px-3 py-2 text-sm hover:border-sky-500 disabled:opacity-50"
            >
              Metadaten bearbeiten ({selected.size})
            </button>
            <button
              onClick={convertSelected}
              disabled={converting}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
            >
              {converting ? "Konvertiere…" : `Auswahl konvertieren (${selected.size})`}
            </button>
          </>
        )}
        <div className="ml-auto text-sm text-neutral-400">
          {stats.total} Titel · {stats.needConvert} zu konvertieren ·{" "}
          {stats.incomplete} Metadaten unvollständig
        </div>
      </div>

      {/* Fortschritt (Scan & Duplikatsuche): gleitet zwischen Buttons und Liste ein/aus. */}
      <div
        className={`overflow-hidden transition-all duration-500 ease-out ${
          showBar ? "mb-4 max-h-24 opacity-100" : "mb-0 max-h-0 opacity-0"
        }`}
      >
        <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-4 py-3">
          <div className="mb-2 flex items-center gap-3 text-sm">
            <span className="text-neutral-300">{progressBar.label}</span>
            <span className="text-neutral-500">
              {progressBar.total > 0
                ? `${progressBar.done} / ${progressBar.total}`
                : ""}
            </span>
            <button
              onClick={progressBar.cancel}
              className="ml-auto rounded-md border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 hover:border-red-500 hover:text-red-300"
            >
              Abbrechen
            </button>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-800">
            <div
              className="h-full rounded-full bg-sky-500 transition-all duration-300 ease-out"
              style={{ width: `${progressBar.pct}%` }}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Fehlt in Library */}
      {sync && sync.missing.length > 0 && (
        <section className="mb-6 rounded-xl border border-teal-500/30 bg-teal-500/5 p-4">
          <h2 className="mb-3 text-sm font-semibold text-teal-200">
            Fehlt in Library ({sync.missing.length})
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {sync.missing.map((item) => {
              const state = dl[item.key] ?? "idle";
              return (
                <div
                  key={item.key}
                  className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900/40 p-2"
                >
                  {item.art_url ? (
                    <img
                      src={item.art_url}
                      className="h-12 w-12 shrink-0 rounded object-cover"
                      alt=""
                    />
                  ) : (
                    <div className="h-12 w-12 shrink-0 rounded bg-neutral-800" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-neutral-100" title={item.title}>
                      {item.title}
                    </p>
                    <p className="truncate text-xs text-neutral-500">
                      {item.band_name}
                    </p>
                  </div>
                  <button
                    onClick={() => void downloadMissing(item)}
                    disabled={!item.download_page_url || state === "loading"}
                    className="shrink-0 rounded-lg bg-teal-600/90 px-3 py-1.5 text-xs font-medium hover:bg-teal-500 disabled:opacity-40"
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

      {/* Filterleiste */}
      {tracks.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
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
            className="ml-auto w-56 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm outline-none focus:border-sky-500"
          />
        </div>
      )}

      {/* Track-Liste / Drop-Zone */}
      <section
        className={`overflow-hidden rounded-xl border-2 border-dashed transition-colors ${
          dragging
            ? "border-sky-500 bg-sky-500/5"
            : "border-neutral-800 bg-neutral-900/20"
        }`}
      >
        {tracks.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 text-neutral-500">
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
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-neutral-500">
            <p className="text-sm">Keine Titel passen zum Filter.</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-neutral-400">
              <tr className="border-b border-neutral-800">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-800"
                    aria-label="Alle auswählen"
                  />
                </th>
                <th className="w-14 px-4 py-3"></th>
                <th className="px-4 py-3 font-medium">Titel</th>
                <th className="px-4 py-3 font-medium">Artist</th>
                <th className="px-4 py-3 font-medium">Album</th>
                <th className="px-4 py-3 font-medium">Format</th>
                <th className="px-4 py-3 font-medium">Länge</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {visibleTracks.map((t) => {
                const prog = progress[t.id];
                const result = results[t.id];
                const fromBandcamp = !!sync?.originById[t.id];
                // Bestätigte Edits sofort in der Liste anzeigen.
                const md = edits[t.id]?.metadata ?? t.metadata;
                return (
                  <tr
                    key={t.id}
                    className="border-b border-neutral-800/60 last:border-0 hover:bg-neutral-800/20"
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(t.id)}
                        onChange={() => toggleSelect(t.id)}
                        className="h-4 w-4 rounded border-neutral-600 bg-neutral-800"
                        aria-label={`${t.file_name} auswählen`}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <CoverThumb path={t.path} hasCover={t.metadata.has_cover} />
                    </td>
                    <td
                      className="max-w-xs truncate px-4 py-3 text-neutral-100"
                      title={t.path}
                    >
                      {md.title || t.file_name}
                    </td>
                    <td className="max-w-[10rem] truncate px-4 py-3 text-neutral-300">
                      {md.artist || "–"}
                    </td>
                    <td className="max-w-[10rem] truncate px-4 py-3 text-neutral-300">
                      {md.album || "–"}
                    </td>
                    <td className="px-4 py-3 text-neutral-300">
                      {t.audio.codec.toUpperCase()}
                      <span className="text-neutral-500">
                        {" "}
                        · {formatSampleRate(t.audio.sample_rate)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-neutral-300">
                      {formatDuration(t.audio.duration_secs)}
                    </td>
                    <td className="px-4 py-3">
                      {result ? (
                        result.success ? (
                          <span className="text-emerald-400">✓ Fertig</span>
                        ) : (
                          <span className="text-red-400" title={result.error ?? ""}>
                            ✕ Fehler
                          </span>
                        )
                      ) : prog && converting ? (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-neutral-800">
                            <div
                              className="h-full bg-sky-500 transition-all"
                              style={{ width: `${prog.percent}%` }}
                            />
                          </div>
                          <span className="text-xs text-neutral-400">
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
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-3">
                        {!t.compat.compatible && (
                          <button
                            onClick={() => convertOne(t)}
                            disabled={converting}
                            className="rounded-md bg-emerald-600/90 px-2 py-1 text-xs font-medium hover:bg-emerald-500 disabled:opacity-40"
                            title="In Zielformat konvertieren"
                          >
                            Konvertieren
                          </button>
                        )}
                        <button
                          onClick={() => setEditingId(t.id)}
                          disabled={converting}
                          className="text-neutral-500 hover:text-sky-400 disabled:opacity-40"
                          title="Metadaten bearbeiten"
                        >
                          ✎
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
              onClose={() => setEditingId(null)}
              onSave={(edit) => saveEdit(editingId, edit)}
            />
          );
        })()}

      {bulkOpen && (
        <BulkMetadataEditor
          count={selected.size}
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
          ? "bg-sky-600/20 text-sky-200 ring-sky-500/40"
          : "text-neutral-400 ring-neutral-700 hover:text-neutral-200 hover:ring-neutral-500"
      }`}
    >
      {label}
    </button>
  );
}
