import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  bandcampCollection,
  bandcampDownload,
  convertTracks,
  onConvertProgress,
  scanLibrary,
} from "../lib/api";
import { formatDuration, formatSampleRate, trackBadges } from "../lib/format";
import { syncCollection, type SyncResult } from "../lib/bandcampSync";
import type { Settings } from "../lib/settings";
import type {
  BandcampAccount,
  BandcampItem,
  ConvertJob,
  ConvertOptions,
  ConvertProgress,
  ConvertResult,
  TrackAnalysis,
  TrackEdit,
} from "../types";
import MetadataEditor from "./MetadataEditor";

interface Props {
  settings: Settings;
  account: BandcampAccount | null;
  onOpenSettings: () => void;
}

type DlState = "idle" | "loading" | "done" | "error";

export default function LibraryView({ settings, account, onOpenSettings }: Props) {
  const [tracks, setTracks] = useState<TrackAnalysis[]>([]);
  const [loading, setLoading] = useState(false);
  const [converting, setConverting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<Record<string, ConvertProgress>>({});
  const [results, setResults] = useState<Record<string, ConvertResult>>({});
  const [edits, setEdits] = useState<Record<string, TrackEdit>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sync, setSync] = useState<SyncResult | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [dl, setDl] = useState<Record<string, DlState>>({});
  const [error, setError] = useState<string | null>(null);

  const libraryDir = settings.library_dir;

  const rescan = useCallback(async () => {
    if (!libraryDir) {
      setTracks([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setTracks(await scanLibrary(libraryDir));
    } catch (e) {
      setError(`Scan fehlgeschlagen: ${e}`);
    } finally {
      setLoading(false);
    }
  }, [libraryDir]);

  useEffect(() => {
    void rescan();
  }, [rescan]);

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
      } catch (e) {
        setError(`Konvertierung fehlgeschlagen: ${e}`);
      } finally {
        unlisten();
        setConverting(false);
        setSelected(new Set());
        await rescan();
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

  const toggleSelectAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === tracks.length ? new Set() : new Set(tracks.map((t) => t.id)),
    );
  }, [tracks]);

  const saveEdit = useCallback((id: string, edit: TrackEdit) => {
    setEdits((prev) => ({ ...prev, [id]: edit }));
    setEditingId(null);
  }, []);

  const stats = useMemo(() => {
    const needConvert = tracks.filter((t) => !t.compat.compatible).length;
    const incomplete = tracks.filter((t) => t.metadata_incomplete).length;
    return { total: tracks.length, needConvert, incomplete };
  }, [tracks]);

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
    <main className="mx-auto max-w-6xl px-6 py-6">
      {/* Toolbar */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <button
          onClick={() => void rescan()}
          disabled={loading || converting}
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
        {selected.size > 0 && (
          <button
            onClick={convertSelected}
            disabled={converting}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {converting ? "Konvertiere…" : `Auswahl konvertieren (${selected.size})`}
          </button>
        )}
        <div className="ml-auto text-sm text-neutral-400">
          {stats.total} Titel · {stats.needConvert} zu konvertieren ·{" "}
          {stats.incomplete} Metadaten unvollständig
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
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-neutral-400">
              <tr className="border-b border-neutral-800">
                <th className="w-10 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.size === tracks.length && tracks.length > 0}
                    onChange={toggleSelectAll}
                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-800"
                    aria-label="Alle auswählen"
                  />
                </th>
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
              {tracks.map((t) => {
                const prog = progress[t.id];
                const result = results[t.id];
                const fromBandcamp = !!sync?.originById[t.id];
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
                    <td
                      className="max-w-xs truncate px-4 py-3 text-neutral-100"
                      title={t.path}
                    >
                      {t.metadata.title || t.file_name}
                    </td>
                    <td className="max-w-[10rem] truncate px-4 py-3 text-neutral-300">
                      {t.metadata.artist || "–"}
                    </td>
                    <td className="max-w-[10rem] truncate px-4 py-3 text-neutral-300">
                      {t.metadata.album || "–"}
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
    </main>
  );
}
