import { useState } from "react";
import { useDismiss } from "../lib/useDismiss";
import type { Playlist } from "../types";

interface Props {
  playlists: Playlist[];
  /** How many of the selected tracks each playlist would gain, by id. */
  gains: Record<number, number>;
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
  gains,
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
        className="h-9 inline-flex items-center justify-center rounded-md border border-border-strong px-3 text-sm enabled:hover:border-accent-500 disabled:border-border disabled:text-fg-disabled"
      >
        Add to playlist ({count})
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-1 max-h-80 w-56 overflow-y-auto rounded-lg border border-border bg-surface-2 py-1 shadow-2xl">
          {playlists.map((p) => {
            // A playlist that already holds every selected track has nothing to
            // gain, and offering it is a click that does nothing. Said rather
            // than hidden: it is also the answer to "is this lot already in
            // there?", which is worth more than a shorter menu.
            const gain = gains[p.id] ?? 0;
            return (
              <button
                key={p.id}
                onClick={() => {
                  setOpen(false);
                  onAdd(p.id);
                }}
                disabled={gain === 0}
                className="h-9 items-center flex w-full items-baseline justify-between gap-2 px-3 text-left text-sm enabled:hover:bg-surface enabled:hover:text-accent-400 disabled:text-fg-disabled"
              >
                <span className="min-w-0 truncate">{p.name}</span>
                <span className="shrink-0 text-xs text-fg-subtle">
                  {gain === 0
                    ? "already in"
                    : gain === count
                      ? `+${gain}`
                      : `+${gain} of ${count}`}
                </span>
              </button>
            );
          })}
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
              className="h-9 inline-flex items-center justify-center block w-full px-3 text-left text-sm text-accent-400 hover:bg-surface"
            >
              New playlist…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
