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
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-medium">
            Duplikate
            {!loading && groups.length > 0 && (
              <span className="ml-2 text-fg-subtle">
                {groups.length} Gruppe{groups.length === 1 ? "" : "n"}
              </span>
            )}
          </h2>
          <button
            onClick={onClose}
            className="text-fg-muted hover:text-fg"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <p className="py-16 text-center text-sm text-fg-muted">Lädt…</p>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-fg-muted">
              <p className="text-lg text-fg">Keine Duplikate gefunden</p>
              <p className="text-sm">
                Alle Tracks in der Library sind eindeutig.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-fg-subtle">
                Wähle pro Gruppe die Datei, die du behalten möchtest. Alle
                anderen werden in den Papierkorb verschoben. Vorausgewählt ist
                die höchste Qualität.
              </p>
              {groups.map((g) => (
                <div
                  key={g.id}
                  className="overflow-hidden rounded-xl border border-border"
                >
                  <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
                    <span className="text-xs text-fg-subtle">
                      {g.files.length} Dateien
                    </span>
                    <button
                      onClick={() => dismissGroup(g.id)}
                      title="Diese Gruppe ist kein Duplikat – aus der Liste entfernen"
                      className="rounded-md border border-border-strong px-2 py-1 text-xs text-fg-muted hover:border-warning-500 hover:text-warning-500"
                    >
                      Kein Duplikat
                    </button>
                  </div>
                  {g.files.map((f) => {
                    const keep = keepById[g.id] === f.id;
                    return (
                      <label
                        key={f.id}
                        className={`flex cursor-pointer items-center gap-3 border-b border-border px-4 py-3 last:border-0 ${
                          keep ? "bg-success-500/5" : "hover:bg-surface-2"
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
                              keep ? "text-fg" : "text-fg-muted"
                            }`}
                            title={f.path}
                          >
                            {f.file_name}
                          </p>
                          <p className="truncate text-xs text-fg-subtle">
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
                            <span className="rounded-full bg-success-500/15 px-2 py-0.5 text-xs text-success-500 ring-1 ring-success-500/30">
                              Behalten
                            </span>
                          ) : (
                            <span className="rounded-full bg-danger-500/15 px-2 py-0.5 text-xs text-danger-500 ring-1 ring-danger-500/30">
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
          <footer className="flex items-center gap-3 border-t border-border px-5 py-3">
            <div className="mr-auto text-sm text-fg-muted">
              {toDelete.paths.length} Datei(en) löschen ·{" "}
              <span className="text-success-500">
                {formatBytes(toDelete.bytes)} frei
              </span>
            </div>
            {error && (
              <span className="max-w-sm truncate text-xs text-danger-500" title={error}>
                {error}
              </span>
            )}
            <button
              onClick={onClose}
              className="rounded-lg border border-border-strong px-4 py-2 text-sm hover:border-border-strong"
            >
              Schließen
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting || toDelete.paths.length === 0}
              className="rounded-lg bg-danger-500 px-4 py-2 text-sm font-medium hover:bg-danger-500/90 disabled:opacity-40"
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
    <span className="rounded-full bg-accent-500/15 px-2 py-0.5 text-xs text-accent-300 ring-1 ring-accent-500/30">
      Verlustfrei
    </span>
  ) : (
    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-fg-muted ring-1 ring-border-strong">
      Verlustbehaftet
    </span>
  );
}
