import { useState } from "react";
import { useDismiss } from "../lib/useDismiss";
import type { Playlist } from "../types";

interface Props {
  playlists: Playlist[];
  count: number;
  disabled?: boolean;
  onAdd: (id: number) => void;
  /** Makes a playlist with this name and puts the selection in it. */
  onCreate: (name: string) => void;
  /** A name that is not taken yet, for the new-playlist field. */
  suggestName: (base: string) => string;
}

/**
 * "Add to playlist" for the current selection.
 *
 * A menu rather than a dialog: picking a playlist is one click, and the list is
 * short enough to read at a glance. Making a new one is the last entry rather
 * than a separate button, because "put these in a new playlist" is the same
 * intention as "put these in that one" — the target simply does not exist yet.
 */
export default function AddToPlaylist({
  playlists,
  count,
  disabled,
  onAdd,
  onCreate,
  suggestName,
}: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => {
    setOpen(false);
    setCreating(false);
  });

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="rounded-lg border border-border-strong px-3 py-2 text-sm enabled:hover:border-accent-500 disabled:border-border disabled:text-fg-disabled"
      >
        Add to playlist ({count})
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-border bg-surface-2 py-1 shadow-2xl">
          {playlists.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setOpen(false);
                onAdd(p.id);
              }}
              className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface hover:text-accent-400"
            >
              <span className="min-w-0 truncate">{p.name}</span>
              <span className="shrink-0 text-xs text-fg-subtle">
                {p.track_count}
              </span>
            </button>
          ))}
          {playlists.length > 0 && <div className="my-1 border-t border-border" />}
          {creating ? (
            <input
              autoFocus
              defaultValue={suggestName("New playlist")}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const name = e.currentTarget.value.trim();
                  setOpen(false);
                  setCreating(false);
                  if (name) onCreate(name);
                }
                if (e.key === "Escape") setCreating(false);
              }}
              onBlur={() => setCreating(false)}
              className="mx-2 my-1 w-[calc(100%-1rem)] rounded-md border border-accent-500 bg-surface px-2 py-1 text-sm outline-none"
              aria-label="New playlist name"
            />
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="block w-full px-3 py-1.5 text-left text-sm text-accent-400 hover:bg-surface"
            >
              New playlist…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
