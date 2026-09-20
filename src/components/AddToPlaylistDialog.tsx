import { useEffect, useRef, useState } from "react";
import Overlay from "./Overlay";
import { PlusIcon } from "./icons";
import type { Playlist } from "../types";

interface Props {
  playlists: Playlist[];
  /** How many of the selected tracks each playlist would gain, by id. */
  gains: Record<number, number>;
  count: number;
  onAdd: (id: number) => void;
  /** Makes a playlist with this name and puts the selection in it. */
  onCreate: (name: string) => void;
  /** A name that is not taken yet, for the new-playlist field. */
  suggestName: (base: string) => string;
  onClose: () => void;
}

/**
 * "Add to playlist" for the current selection.
 *
 * A dialog rather than a menu, which it was until 0.10.0. The menu was wrong
 * twice in a way a dialog cannot be: it opened upward into the sticky header
 * and was unreachable (0.8.1), and it was anchored to a button whose position
 * moves with the selection, because the header's action buttons appear and
 * disappear as rows are picked. A centred overlay depends on nothing above or
 * below its trigger, and it has room for a list longer than a dropdown wants
 * to be.
 *
 * **It stays in the library**, which is the question the roadmap left open when
 * playlists got a view of their own. It looked like the view would absorb this
 * dialog, and that mistakes which half is which: the dialog has a destination
 * half — a list of playlists — and a subject half, which is a selection made in
 * *this* table. Only the second is expensive, and it cannot leave the table it
 * is made in. A picker in the playlists view would be a list of destinations
 * with nothing to send.
 *
 * Like the editor, it holds no playlist state. Every change goes back through
 * `usePlaylists`, so there is one place playlist state lives.
 */
export default function AddToPlaylistDialog({
  playlists,
  gains,
  count,
  onAdd,
  onCreate,
  suggestName,
  onClose,
}: Props) {
  // With nothing to pick from, the only action is the one below the list, so
  // the dialog opens on it rather than on an empty list and a button.
  const [creating, setCreating] = useState(playlists.length === 0);
  const [name, setName] = useState(() =>
    playlists.length === 0 ? suggestName("New playlist") : "",
  );
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // The panel, not the first control: focus here announces the dialog by its
    // own name, leaves the first Tab on the first playlist, and makes Escape
    // work before the pointer has touched anything.
    if (!creating) panel.current?.focus();
    // Only on open; moving focus again when the field appears would take it
    // off the field the user is about to type into.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const commit = () => {
    const next = name.trim();
    if (!next) return;
    onCreate(next);
    onClose();
  };

  return (
    <Overlay onClose={onClose}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-to-playlist-title"
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          <h2 id="add-to-playlist-title" className="text-sm font-medium">
            Add to playlist
          </h2>
          <span className="shrink-0 text-sm text-fg-subtle">
            {count === 1 ? "1 track selected" : `${count} tracks selected`}
          </span>
          <button
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-fg-muted hover:text-fg"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {playlists.length === 0 ? (
            <p className="font-sans text-sm text-fg-subtle">
              No playlists yet. Name one below and the selection goes into it.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {playlists.map((p) => {
                // A playlist that already holds every selected track has
                // nothing to gain, and offering it is a click that does
                // nothing. Said rather than hidden: it is also the answer to
                // "is this lot already in there?", which is worth more than a
                // shorter list.
                const gain = gains[p.id] ?? 0;
                return (
                  <li key={p.id}>
                    <button
                      onClick={() => {
                        onAdd(p.id);
                        onClose();
                      }}
                      disabled={gain === 0}
                      className="h-9 flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface-2 px-3 text-left text-sm enabled:hover:border-accent-500 enabled:hover:text-fg-accent disabled:text-fg-disabled"
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
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          {/* Making a new one is an action of its own here, not the last row of
              a list — which is what it had to be in a menu. */}
          {creating ? (
            <>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commit();
                  if (e.key === "Escape") {
                    // The field's Escape cancels the field. `Overlay` listens
                    // for Escape on `document`, so without this the dialog
                    // would go with it.
                    e.stopPropagation();
                    setCreating(false);
                  }
                }}
                className="h-9 min-w-0 flex-1 rounded-md border border-accent-500 bg-surface-2 px-2 text-sm"
                aria-label="New playlist name"
              />
              <button
                onClick={commit}
                disabled={!name.trim()}
                className="h-9 inline-flex shrink-0 items-center justify-center rounded-md bg-accent-600 px-4 text-sm font-medium text-white enabled:hover:bg-accent-500 disabled:bg-surface-2 disabled:text-fg-disabled"
              >
                Create and add
              </button>
            </>
          ) : (
            <>
              <button
                onClick={() => {
                  setName(suggestName("New playlist"));
                  setCreating(true);
                }}
                className="h-9 inline-flex items-center justify-center gap-2 rounded-md border border-border-strong px-3 text-sm hover:border-accent-500 hover:text-fg-accent"
              >
                <PlusIcon />
                New playlist
              </button>
              <button
                onClick={onClose}
                className="h-9 inline-flex items-center justify-center rounded-md bg-accent-600 px-4 text-sm font-medium text-white hover:bg-accent-500"
              >
                Done
              </button>
            </>
          )}
        </footer>
      </div>
    </Overlay>
  );
}
