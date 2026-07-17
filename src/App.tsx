import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import BandcampPanel from "./components/BandcampPanel";
import MetadataEditor from "./components/MetadataEditor";
import {
  analyzeFiles,
  convertTracks,
  onConvertProgress,
  pickAudioFiles,
  pickOutputDir,
} from "./lib/api";
import {
  FORMAT_LABELS,
  NEWER_PLAYERS_ONLY,
  type ConvertJob,
  type ConvertOptions,
  type ConvertProgress,
  type ConvertResult,
  type TargetFormat,
  type TrackAnalysis,
  type TrackEdit,
} from "./types";

// Bandcamp-Integration aktiv (Phase 3).
/** Sind die Pflichtfelder (Titel/Artist/Album + Cover) gesetzt? */
function editComplete(edit: TrackEdit): boolean {
  const m = edit.metadata;
  return (
    !!m.title?.trim() && !!m.artist?.trim() && !!m.album?.trim() && m.has_cover
  );
}

function formatDuration(secs: number): string {
  if (!secs || secs < 0) return "–";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatSampleRate(hz: number): string {
  if (!hz) return "–";
  return `${(hz / 1000).toFixed(1)} kHz`;
}

type Badge = { label: string; className: string; title?: string };

function trackBadges(t: TrackAnalysis, edit?: TrackEdit): Badge[] {
  const badges: Badge[] = [];
  if (t.compat.compatible) {
    badges.push({
      label: "Kompatibel",
      className: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    });
  } else {
    badges.push({
      label: "Konvertieren",
      className: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
      title: t.compat.issues.map((i) => i.message).join("\n"),
    });
  }
  const warnings = t.compat.issues.filter((i) => i.severity === "warning");
  if (t.compat.compatible && warnings.length) {
    badges.push({
      label: "Hinweis",
      className: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
      title: warnings.map((i) => i.message).join("\n"),
    });
  }
  const complete = edit ? editComplete(edit) : !t.metadata_incomplete;
  if (edit && complete) {
    badges.push({
      label: "Metadaten ✓",
      className: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    });
  } else if (!complete) {
    badges.push({
      label: "Metadaten unvollständig",
      className: "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30",
    });
  }
  return badges;
}

export default function App() {
  const [tracks, setTracks] = useState<TrackAnalysis[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [converting, setConverting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<Record<string, ConvertProgress>>({});
  const [results, setResults] = useState<Record<string, ConvertResult>>({});
  const [edits, setEdits] = useState<Record<string, TrackEdit>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showBandcamp, setShowBandcamp] = useState(false);
  const [options, setOptions] = useState<ConvertOptions>({
    format: "aiff",
    bit_depth: 16,
    output_dir: null,
    sanitize_filenames: false,
  });

  // Vermeidet Doppelanalysen bei mehrfachem Drop.
  const knownPaths = useRef<Set<string>>(new Set());

  const addPaths = useCallback(async (paths: string[]) => {
    const fresh = paths.filter((p) => !knownPaths.current.has(p));
    if (!fresh.length) return;
    fresh.forEach((p) => knownPaths.current.add(p));
    setAnalyzing(true);
    try {
      const analyzed = await analyzeFiles(fresh);
      setTracks((prev) => {
        const byId = new Map(prev.map((t) => [t.id, t]));
        analyzed.forEach((t) => byId.set(t.id, t));
        return Array.from(byId.values());
      });
    } catch (e) {
      console.error(e);
      alert(`Analyse fehlgeschlagen: ${e}`);
    } finally {
      setAnalyzing(false);
    }
  }, []);

  // Drag & Drop über das Tauri-Fenster.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over" || event.payload.type === "enter") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          void addPaths(event.payload.paths);
        } else {
          setDragging(false);
        }
      })
      .then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [addPaths]);

  const handleAdd = useCallback(async () => {
    const paths = await pickAudioFiles();
    if (paths.length) void addPaths(paths);
  }, [addPaths]);

  const handleChooseOutput = useCallback(async () => {
    const dir = await pickOutputDir();
    if (dir) setOptions((o) => ({ ...o, output_dir: dir }));
  }, []);

  const handleConvert = useCallback(async () => {
    if (!tracks.length) return;
    setConverting(true);
    setProgress({});
    setResults({});
    const unlisten = await onConvertProgress((p) =>
      setProgress((prev) => ({ ...prev, [p.id]: p })),
    );
    try {
      const jobs: ConvertJob[] = tracks.map((t) => {
        const edit = edits[t.id];
        return {
          id: t.id,
          path: t.path,
          metadata: edit?.metadata ?? null,
          cover: edit?.cover ?? null,
        };
      });
      const res = await convertTracks(jobs, options);
      const map: Record<string, ConvertResult> = {};
      res.forEach((r) => (map[r.id] = r));
      setResults(map);
    } catch (e) {
      console.error(e);
      alert(`Konvertierung fehlgeschlagen: ${e}`);
    } finally {
      unlisten();
      setConverting(false);
    }
  }, [tracks, options, edits]);

  const clearAll = useCallback(() => {
    knownPaths.current.clear();
    setTracks([]);
    setProgress({});
    setResults({});
    setEdits({});
  }, []);

  const removeTrack = useCallback((id: string) => {
    knownPaths.current.delete(id);
    setTracks((prev) => prev.filter((t) => t.id !== id));
    setEdits((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const saveEdit = useCallback((id: string, edit: TrackEdit) => {
    setEdits((prev) => ({ ...prev, [id]: edit }));
    setEditingId(null);
  }, []);

  const stats = useMemo(() => {
    const needConvert = tracks.filter((t) => !t.compat.compatible).length;
    const incomplete = tracks.filter((t) => t.metadata_incomplete).length;
    return { total: tracks.length, needConvert, incomplete };
  }, [tracks]);

  const newerOnly = NEWER_PLAYERS_ONLY.includes(options.format);
  const pcmFormat = options.format === "aiff" || options.format === "wav";

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between gap-4 border-b border-neutral-800 bg-neutral-900/60 px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">
          rekord-lib
          <span className="ml-2 text-sm font-normal text-neutral-400">
            CDJ/XDJ- &amp; Rekordbox-kompatible Audio-Aufbereitung
          </span>
        </h1>
        <button
          onClick={() => setShowBandcamp(true)}
          disabled={converting}
          className="shrink-0 rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium hover:border-sky-500 disabled:opacity-50"
        >
          Bandcamp
        </button>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-6">
        {/* Optionen */}
        <section className="mb-6 grid grid-cols-1 gap-4 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Zielformat</span>
            <select
              value={options.format}
              onChange={(e) =>
                setOptions((o) => ({ ...o, format: e.target.value as TargetFormat }))
              }
              className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 outline-none focus:border-sky-500"
            >
              {(Object.keys(FORMAT_LABELS) as TargetFormat[]).map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Bit-Tiefe</span>
            <select
              value={options.bit_depth}
              disabled={!pcmFormat && options.format !== "flac" && options.format !== "alac"}
              onChange={(e) =>
                setOptions((o) => ({ ...o, bit_depth: Number(e.target.value) }))
              }
              className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 outline-none focus:border-sky-500 disabled:opacity-40"
            >
              <option value={16}>16-bit (sicher)</option>
              <option value={24}>24-bit</option>
            </select>
          </label>

          <div className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Ausgabeordner</span>
            <button
              onClick={handleChooseOutput}
              className="truncate rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-left hover:border-sky-500"
              title={options.output_dir ?? "Neben der Quelldatei"}
            >
              {options.output_dir ?? "Neben Quelldatei"}
            </button>
          </div>

          <label className="flex items-end gap-2 text-sm">
            <input
              type="checkbox"
              checked={options.sanitize_filenames}
              onChange={(e) =>
                setOptions((o) => ({ ...o, sanitize_filenames: e.target.checked }))
              }
              className="h-4 w-4 rounded border-neutral-600 bg-neutral-800"
            />
            <span className="pb-2">Dateinamen bereinigen</span>
          </label>
        </section>

        {newerOnly && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
            ⚠️ {options.format.toUpperCase()} läuft nur auf neueren Playern
            (CDJ-3000/NXS2), nicht auf allen CDJ/XDJ. Für maximale Kompatibilität AIFF wählen.
          </div>
        )}

        {/* Aktionen */}
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <button
            onClick={handleAdd}
            disabled={analyzing || converting}
            className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500 disabled:opacity-50"
          >
            Dateien hinzufügen
          </button>
          <button
            onClick={handleConvert}
            disabled={!tracks.length || analyzing || converting}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
          >
            {converting ? "Konvertiere…" : `Konvertieren (${tracks.length})`}
          </button>
          {tracks.length > 0 && (
            <button
              onClick={clearAll}
              disabled={converting}
              className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:border-neutral-500 disabled:opacity-50"
            >
              Leeren
            </button>
          )}
          <div className="ml-auto text-sm text-neutral-400">
            {stats.total} Dateien · {stats.needConvert} zu konvertieren ·{" "}
            {stats.incomplete} Metadaten
          </div>
        </div>

        {/* Track-Liste / Drop-Zone */}
        <section
          className={`rounded-xl border-2 border-dashed transition-colors ${
            dragging
              ? "border-sky-500 bg-sky-500/5"
              : "border-neutral-800 bg-neutral-900/20"
          }`}
        >
          {tracks.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-2 text-neutral-500">
              <p className="text-lg">Audiodateien hierher ziehen</p>
              <p className="text-sm">oder „Dateien hinzufügen" nutzen</p>
              {analyzing && (
                <p className="text-sm text-sky-400">Analysiere…</p>
              )}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-neutral-400">
                <tr className="border-b border-neutral-800">
                  <th className="px-4 py-3 font-medium">Datei</th>
                  <th className="px-4 py-3 font-medium">Format</th>
                  <th className="px-4 py-3 font-medium">Rate</th>
                  <th className="px-4 py-3 font-medium">Länge</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {tracks.map((t) => {
                  const prog = progress[t.id];
                  const result = results[t.id];
                  return (
                    <tr
                      key={t.id}
                      className="border-b border-neutral-800/60 last:border-0"
                    >
                      <td className="max-w-xs truncate px-4 py-3" title={t.path}>
                        {t.file_name}
                      </td>
                      <td className="px-4 py-3 text-neutral-300">
                        {t.audio.codec.toUpperCase()}
                        {t.audio.bits_per_sample > 0 && (
                          <span className="text-neutral-500">
                            {" "}
                            · {t.audio.bits_per_sample}-bit
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-neutral-300">
                        {formatSampleRate(t.audio.sample_rate)}
                      </td>
                      <td className="px-4 py-3 text-neutral-300">
                        {formatDuration(t.audio.duration_secs)}
                      </td>
                      <td className="px-4 py-3">
                        {result ? (
                          result.success ? (
                            <span className="text-emerald-400">✓ Fertig</span>
                          ) : (
                            <span
                              className="text-red-400"
                              title={result.error ?? ""}
                            >
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
                            {trackBadges(t, edits[t.id]).map((b, i) => (
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
                          <button
                            onClick={() => setEditingId(t.id)}
                            disabled={converting}
                            className="text-neutral-500 hover:text-sky-400 disabled:opacity-40"
                            title="Metadaten bearbeiten"
                          >
                            ✎
                          </button>
                          <button
                            onClick={() => removeTrack(t.id)}
                            disabled={converting}
                            className="text-neutral-500 hover:text-red-400 disabled:opacity-40"
                            title="Entfernen"
                          >
                            ✕
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
      </main>

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

      {showBandcamp && (
        <BandcampPanel
          defaultDir={options.output_dir}
          onClose={() => setShowBandcamp(false)}
          onImport={(paths) => void addPaths(paths)}
        />
      )}
    </div>
  );
}
