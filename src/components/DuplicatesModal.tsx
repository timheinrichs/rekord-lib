import { useMemo, useState } from "react";
import { formatBytes, formatDuration, formatSampleRate } from "../lib/format";
import type { DuplicateFile, DuplicateGroup } from "../types";
import { TrashIcon } from "./icons";

interface Props {
  groups: DuplicateGroup[];
  scanning: boolean;
  onClose: () => void;
  /** Move files to the trash (parent updates groups/library). */
  onDeleteFiles: (paths: string[]) => Promise<void>;
  /** Dismiss a group as "not a duplicate". */
  onDismissGroup: (id: string) => void;
  /** Start a new scan. */
  onRescan: () => void;
}

export default function DuplicatesModal({
  groups,
  scanning,
  onClose,
  onDeleteFiles,
  onDismissGroup,
  onRescan,
}: Props) {
  // Which file to keep per group (UI selection, otherwise the suggestion).
  const [keepOverride, setKeepOverride] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const keepFor = (g: DuplicateGroup): string => {
    const chosen = keepOverride[g.id];
    if (chosen && g.files.some((f) => f.id === chosen)) return chosen;
    if (g.files.some((f) => f.id === g.keep_id)) return g.keep_id;
    return g.files[0]?.id ?? "";
  };

  const toDelete = useMemo(() => {
    const paths: string[] = [];
    let bytes = 0;
    for (const g of groups) {
      const keep = keepFor(g);
      for (const f of g.files) {
        if (f.id !== keep) {
          paths.push(f.path);
          bytes += f.size_bytes;
        }
      }
    }
    return { paths, bytes };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, keepOverride]);

  const runDelete = async (paths: string[]) => {
    if (!paths.length || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onDeleteFiles(paths);
    } catch (e) {
      setError(`Deletion failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-medium">
            Duplicates
            {groups.length > 0 && (
              <span className="ml-2 text-fg-subtle">
                {groups.length} group{groups.length === 1 ? "" : "s"}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={onRescan}
              disabled={scanning}
              className="rounded-md border border-border-strong px-2.5 py-1 text-xs text-fg-muted hover:border-accent-500 hover:text-accent-400 disabled:opacity-40"
            >
              {scanning ? "Searching…" : "Search again"}
            </button>
            <button onClick={onClose} className="text-fg-muted hover:text-fg" aria-label="Close">
              ✕
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {groups.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-fg-muted">
              <p className="text-lg text-fg">
                {scanning ? "Searching…" : "No duplicates found"}
              </p>
              {!scanning && (
                <p className="text-sm">All tracks in the library are unique.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-xs text-fg-subtle">
                For each group, choose the file you want to keep. You can move
                the others to the trash individually or all at once.
              </p>
              {groups.map((g) => {
                const keep = keepFor(g);
                return (
                  <div key={g.id} className="overflow-hidden rounded-xl border border-border">
                    <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-2">
                      <span className="text-xs text-fg-subtle">{g.files.length} files</span>
                      <button
                        onClick={() => onDismissGroup(g.id)}
                        title="This group is not a duplicate – remove it from the list"
                        className="rounded-md border border-border-strong px-2 py-1 text-xs text-fg-muted hover:border-warning-500 hover:text-warning-500"
                      >
                        Not a duplicate
                      </button>
                    </div>
                    {g.files.map((f) => {
                      const isKeep = keep === f.id;
                      return (
                        <div
                          key={f.id}
                          className={`flex items-center gap-3 border-b border-border/60 px-4 py-3 last:border-0 ${
                            isKeep ? "bg-success-500/5" : ""
                          }`}
                        >
                          <input
                            type="radio"
                            name={`keep-${g.id}`}
                            checked={isKeep}
                            onChange={() =>
                              setKeepOverride((s) => ({ ...s, [g.id]: f.id }))
                            }
                            className="h-4 w-4 shrink-0"
                            aria-label="Keep"
                          />
                          <div className="min-w-0 flex-1">
                            <p
                              className={`truncate text-sm ${isKeep ? "text-fg" : "text-fg-muted"}`}
                              title={f.path}
                            >
                              {f.file_name}
                            </p>
                            <p className="truncate text-xs text-fg-subtle">
                              {f.codec.toUpperCase()} · {formatSampleRate(f.sample_rate)}
                              {f.bits_per_sample > 0 && ` · ${f.bits_per_sample} bit`} ·{" "}
                              {formatDuration(f.duration_secs)} · {formatBytes(f.size_bytes)}
                            </p>
                          </div>
                          <QualityBadge f={f} />
                          {isKeep ? (
                            <span className="rounded-full bg-success-500/15 px-2 py-0.5 text-xs text-success-500 ring-1 ring-success-500/30">
                              Keep
                            </span>
                          ) : (
                            <button
                              onClick={() => void runDelete([f.path])}
                              disabled={busy}
                              title="Move this file to the trash"
                              aria-label="Move to trash"
                              className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface-2 hover:text-danger-500 disabled:opacity-40"
                            >
                              <TrashIcon />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {groups.length > 0 && (
          <footer className="flex items-center gap-3 border-t border-border px-5 py-3">
            <div className="mr-auto text-sm text-fg-muted">
              {toDelete.paths.length} file(s) ·{" "}
              <span className="text-success-500">{formatBytes(toDelete.bytes)} free</span>
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
              Close
            </button>
            <button
              onClick={() => void runDelete(toDelete.paths)}
              disabled={busy || toDelete.paths.length === 0}
              className="rounded-lg bg-danger-500 px-4 py-2 text-sm font-medium text-white hover:bg-danger-500/90 disabled:opacity-40"
            >
              {busy ? "Moving…" : `All not kept (${toDelete.paths.length})`}
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
      Lossless
    </span>
  ) : (
    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-fg-muted ring-1 ring-border-strong">
      Lossy
    </span>
  );
}
