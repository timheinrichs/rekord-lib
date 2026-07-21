import { useMemo, useState } from "react";
import { formatBytes, formatDuration, formatSampleRate } from "../lib/format";
import {
  clusterAlbums,
  deleteSetForAlbum,
  trackGroupsOutsideAlbums,
  type DuplicateAlbum,
} from "../lib/dupAlbums";
import type { DuplicateFile, DuplicateGroup } from "../types";
import { ChevronIcon, TrashIcon } from "./icons";

interface Props {
  groups: DuplicateGroup[];
  scanning: boolean;
  onClose: () => void;
  /** Move files to the trash (parent updates groups/library + prunes folders). */
  onDeleteFiles: (paths: string[]) => Promise<void>;
  /** Dismiss a group as "not a duplicate". */
  onDismissGroup: (id: string) => void;
  /** Start a new scan. */
  onRescan: () => void;
}

function folderName(dir: string): string {
  const i = dir.lastIndexOf("/");
  return i >= 0 ? dir.slice(i + 1) : dir;
}

export default function DuplicatesModal({
  groups,
  scanning,
  onClose,
  onDeleteFiles,
  onDismissGroup,
  onRescan,
}: Props) {
  const [keepOverride, setKeepOverride] = useState<Record<string, string>>({});
  const [albumKeep, setAlbumKeep] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const albums = useMemo(() => clusterAlbums(groups), [groups]);
  const loneGroups = useMemo(
    () => trackGroupsOutsideAlbums(groups, albums),
    [groups, albums],
  );

  const albumKeepFor = (a: DuplicateAlbum) => albumKeep[a.id] ?? a.keepKey;

  const keepFor = (g: DuplicateGroup): string => {
    const chosen = keepOverride[g.id];
    if (chosen && g.files.some((f) => f.id === chosen)) return chosen;
    if (g.files.some((f) => f.id === g.keep_id)) return g.keep_id;
    return g.files[0]?.id ?? "";
  };

  const toDelete = useMemo(() => {
    const paths: string[] = [];
    let bytes = 0;
    for (const g of loneGroups) {
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
  }, [loneGroups, keepOverride]);

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

  const empty = albums.length === 0 && loneGroups.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-medium">
            Duplicates
            {!empty && (
              <span className="ml-2 text-fg-subtle">
                {albums.length > 0 &&
                  `${albums.length} album${albums.length === 1 ? "" : "s"}`}
                {albums.length > 0 && loneGroups.length > 0 && " · "}
                {loneGroups.length > 0 &&
                  `${loneGroups.length} track${loneGroups.length === 1 ? "" : "s"}`}
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
          {empty ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-fg-muted">
              <p className="text-lg text-fg">
                {scanning ? "Searching…" : "No duplicates found"}
              </p>
              {!scanning && (
                <p className="text-sm">All tracks in the library are unique.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-6">
              {/* Album-level duplicates */}
              {albums.length > 0 && (
                <section className="flex flex-col gap-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                    Duplicate albums
                  </h3>
                  {albums.map((a) => {
                    const keep = albumKeepFor(a);
                    const del = deleteSetForAlbum(a, keep);
                    const delBytes = a.versions
                      .filter((v) => v.key !== keep)
                      .reduce((s, v) => s + v.sizeBytes, 0);
                    const isOpen = expanded[a.id] ?? false;
                    return (
                      <div key={a.id} className="overflow-hidden rounded-xl border border-border">
                        <div className="flex items-center gap-2 border-b border-border bg-surface px-4 py-2.5">
                          <span className="truncate text-sm font-medium text-fg" title={a.title}>
                            {a.title}
                          </span>
                          <span className="whitespace-nowrap text-xs text-fg-subtle">
                            {a.versions.length} versions · {a.tracks.length} matching tracks
                          </span>
                          <button
                            onClick={() => a.tracks.forEach((g) => onDismissGroup(g.id))}
                            title="These albums are not duplicates – remove them from the list"
                            className="ml-auto shrink-0 rounded-md border border-border-strong px-2 py-1 text-xs text-fg-muted hover:border-warning-500 hover:text-warning-500"
                          >
                            Not a duplicate
                          </button>
                        </div>

                        <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
                          {a.versions.map((v) => {
                            const isKeep = keep === v.key;
                            return (
                              <label
                                key={v.key}
                                className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                                  isKeep
                                    ? "border-success-500/40 bg-success-500/5"
                                    : "border-border hover:border-border-strong"
                                }`}
                              >
                                <input
                                  type="radio"
                                  name={`album-${a.id}`}
                                  checked={isKeep}
                                  onChange={() =>
                                    setAlbumKeep((s) => ({ ...s, [a.id]: v.key }))
                                  }
                                  className="mt-0.5 h-4 w-4 shrink-0"
                                  aria-label={`Keep ${folderName(v.key)}`}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate text-sm text-fg" title={v.key}>
                                      {folderName(v.key)}
                                    </span>
                                    {v.lossless ? (
                                      <span className="shrink-0 rounded-full bg-accent-500/15 px-2 py-0.5 text-[11px] text-accent-300 ring-1 ring-accent-500/30">
                                        Lossless
                                      </span>
                                    ) : (
                                      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-fg-muted ring-1 ring-border-strong">
                                        Lossy
                                      </span>
                                    )}
                                  </div>
                                  <p className="truncate text-xs text-fg-subtle">
                                    {v.formatSummary} · {v.trackCount} tracks ·{" "}
                                    {formatBytes(v.sizeBytes)}
                                  </p>
                                  {isKeep && (
                                    <span className="mt-1 inline-block text-[11px] text-success-500">
                                      Keep this version
                                    </span>
                                  )}
                                </div>
                              </label>
                            );
                          })}
                        </div>

                        <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-2.5">
                          <button
                            onClick={() =>
                              setExpanded((s) => ({ ...s, [a.id]: !isOpen }))
                            }
                            className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
                          >
                            <ChevronIcon open={isOpen} />
                            {isOpen ? "Hide tracks" : "Show tracks"}
                          </button>
                          <div className="ml-auto flex items-center gap-3">
                            <span className="text-xs text-fg-subtle">
                              {del.length} file{del.length === 1 ? "" : "s"} ·{" "}
                              <span className="text-success-500">
                                {formatBytes(delBytes)} free
                              </span>
                            </span>
                            <button
                              onClick={() => void runDelete(del)}
                              disabled={busy || del.length === 0}
                              className="rounded-lg bg-danger-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-danger-500/90 disabled:opacity-40"
                            >
                              Keep selected · delete others
                            </button>
                          </div>
                        </div>

                        {isOpen && (
                          <div className="border-t border-border bg-surface-2/30 px-4 py-2">
                            {a.tracks.map((g) => (
                              <div key={g.id} className="border-b border-border/40 py-2 last:border-0">
                                {g.files.map((f) => {
                                  const inKeep = f.path.startsWith(`${keep}/`);
                                  return (
                                    <p
                                      key={f.id}
                                      className={`truncate text-xs ${
                                        inKeep ? "text-fg" : "text-fg-subtle line-through"
                                      }`}
                                      title={f.path}
                                    >
                                      {folderName(dirOf(f.path))} · {f.title || f.file_name}
                                    </p>
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </section>
              )}

              {/* Track-level duplicates (not part of an album) */}
              {loneGroups.length > 0 && (
                <section className="flex flex-col gap-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-fg-subtle">
                    Duplicate tracks
                  </h3>
                  <p className="text-xs text-fg-subtle">
                    For each group, choose the file you want to keep. You can move
                    the others to the trash individually or all at once.
                  </p>
                  {loneGroups.map((g) => {
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
                                  {f.title || f.file_name}
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
                </section>
              )}
            </div>
          )}
        </div>

        {loneGroups.length > 0 && (
          <footer className="flex items-center gap-3 border-t border-border px-5 py-3">
            <div className="mr-auto text-sm text-fg-muted">
              {toDelete.paths.length} track file(s) ·{" "}
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
              {busy ? "Moving…" : `All tracks not kept (${toDelete.paths.length})`}
            </button>
          </footer>
        )}
        {loneGroups.length === 0 && !empty && (
          <footer className="flex items-center justify-end gap-3 border-t border-border px-5 py-3">
            {error && (
              <span className="mr-auto max-w-sm truncate text-xs text-danger-500" title={error}>
                {error}
              </span>
            )}
            <button
              onClick={onClose}
              className="rounded-lg border border-border-strong px-4 py-2 text-sm hover:border-border-strong"
            >
              Close
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "";
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
