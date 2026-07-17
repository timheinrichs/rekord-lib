import { useEffect, useMemo, useState } from "react";
import { dedupeResult, deleteFiles } from "../lib/api";
import { formatBytes, formatDuration, formatSampleRate } from "../lib/format";
import type { DuplicateFile, DuplicateGroup } from "../types";

interface Props {
  onClose: () => void;
  onDeleted: (paths: string[]) => void;
}

export default function DuplicatesModal({ onClose, onDeleted }: Props) {
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<DuplicateGroup[]>([]);
  const [keepById, setKeepById] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Ergebnis der (bereits gelaufenen) Suche laden.
  useEffect(() => {
    let active = true;
    void (async () => {
      const result = (await dedupeResult()) ?? [];
      if (!active) return;
      setGroups(result);
      setKeepById(Object.fromEntries(result.map((g) => [g.id, g.keep_id])));
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Alle nicht-behaltenen Dateien sind zum Löschen vorgemerkt.
  const toDelete = useMemo(() => {
    const paths: string[] = [];
    let bytes = 0;
    for (const g of groups) {
      const keep = keepById[g.id];
      for (const f of g.files) {
        if (f.id !== keep) {
          paths.push(f.path);
          bytes += f.size_bytes;
        }
      }
    }
    return { paths, bytes };
  }, [groups, keepById]);

  // Eine Gruppe als „kein Duplikat" verwerfen (nur aus der Ansicht entfernen).
  const dismissGroup = (id: string) => {
    setGroups((gs) => gs.filter((g) => g.id !== id));
  };

  const handleDelete = async () => {
    if (!toDelete.paths.length) return;
    setDeleting(true);
    setError(null);
    try {
      const results = await deleteFiles(toDelete.paths);
      const failed = results.filter((r) => !r.success);
      const deleted = results.filter((r) => r.success).map((r) => r.path);
      if (failed.length) {
        setError(
          `${failed.length} Datei(en) konnten nicht gelöscht werden: ${failed
            .map((f) => f.error)
            .filter(Boolean)
            .join("; ")}`,
        );
      }
      onDeleted(deleted);
    } catch (e) {
      setError(`Löschen fehlgeschlagen: ${e}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-sm font-medium">
            Duplikate
            {!loading && groups.length > 0 && (
              <span className="ml-2 text-neutral-500">
                {groups.length} Gruppe{groups.length === 1 ? "" : "n"}
              </span>
            )}
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-100"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <p className="py-16 text-center text-sm text-neutral-400">Lädt…</p>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-neutral-400">
              <p className="text-lg text-neutral-200">Keine Duplikate gefunden</p>
              <p className="text-sm">
                Alle Tracks in der Library sind eindeutig.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-neutral-500">
                Wähle pro Gruppe die Datei, die du behalten möchtest. Alle
                anderen werden in den Papierkorb verschoben. Vorausgewählt ist
                die höchste Qualität.
              </p>
              {groups.map((g) => (
                <div
                  key={g.id}
                  className="overflow-hidden rounded-xl border border-neutral-800"
                >
                  <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/60 px-4 py-2">
                    <span className="text-xs text-neutral-500">
                      {g.files.length} Dateien
                    </span>
                    <button
                      onClick={() => dismissGroup(g.id)}
                      title="Diese Gruppe ist kein Duplikat – aus der Liste entfernen"
                      className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-amber-500 hover:text-amber-300"
                    >
                      Kein Duplikat
                    </button>
                  </div>
                  {g.files.map((f) => {
                    const keep = keepById[g.id] === f.id;
                    return (
                      <label
                        key={f.id}
                        className={`flex cursor-pointer items-center gap-3 border-b border-neutral-800/60 px-4 py-3 last:border-0 ${
                          keep ? "bg-emerald-500/5" : "hover:bg-neutral-800/30"
                        }`}
                      >
                        <input
                          type="radio"
                          name={`keep-${g.id}`}
                          checked={keep}
                          onChange={() =>
                            setKeepById((s) => ({ ...s, [g.id]: f.id }))
                          }
                          className="h-4 w-4 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <p
                            className={`truncate text-sm ${
                              keep ? "text-neutral-100" : "text-neutral-400"
                            }`}
                            title={f.path}
                          >
                            {f.file_name}
                          </p>
                          <p className="truncate text-xs text-neutral-500">
                            {f.codec.toUpperCase()} ·{" "}
                            {formatSampleRate(f.sample_rate)}
                            {f.bits_per_sample > 0 &&
                              ` · ${f.bits_per_sample} bit`}{" "}
                            · {formatDuration(f.duration_secs)} ·{" "}
                            {formatBytes(f.size_bytes)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <QualityBadge f={f} />
                          {keep ? (
                            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs text-emerald-300 ring-1 ring-emerald-500/30">
                              Behalten
                            </span>
                          ) : (
                            <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-300 ring-1 ring-red-500/30">
                              Löschen
                            </span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        {!loading && groups.length > 0 && (
          <footer className="flex items-center gap-3 border-t border-neutral-800 px-5 py-3">
            <div className="mr-auto text-sm text-neutral-400">
              {toDelete.paths.length} Datei(en) löschen ·{" "}
              <span className="text-emerald-300">
                {formatBytes(toDelete.bytes)} frei
              </span>
            </div>
            {error && (
              <span className="max-w-sm truncate text-xs text-red-300" title={error}>
                {error}
              </span>
            )}
            <button
              onClick={onClose}
              className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:border-neutral-500"
            >
              Schließen
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting || toDelete.paths.length === 0}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium hover:bg-red-500 disabled:opacity-40"
            >
              {deleting
                ? "Verschiebe…"
                : `In den Papierkorb (${toDelete.paths.length})`}
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function QualityBadge({ f }: { f: DuplicateFile }) {
  return f.lossless ? (
    <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-xs text-sky-300 ring-1 ring-sky-500/30">
      Verlustfrei
    </span>
  ) : (
    <span className="rounded-full bg-neutral-700/40 px-2 py-0.5 text-xs text-neutral-400 ring-1 ring-neutral-600/40">
      Verlustbehaftet
    </span>
  );
}
