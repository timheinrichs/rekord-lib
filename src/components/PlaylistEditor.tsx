import { useEffect, useRef, useState } from "react";
import Overlay from "./Overlay";
import { TrashIcon } from "./icons";
import type { PlaylistRow } from "../lib/playlists";
import type { Playlist } from "../types";

interface Props {
  playlist: Playlist;
  /** Every stored entry, in order — including the ones the table skips. */
  rows: PlaylistRow[];
  onRename: (name: string) => void;
  onStep: (path: string, step: -1 | 1) => void;
  onRemove: (path: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

/**
 * A playlist as a list you can edit, rather than as a grouping you can only
 * read.
 *
 * The table already reorders and removes, so this is deliberately not a second
 * mechanism: every button here calls the same `usePlaylists` operation the row
 * actions do, which computes the new order with the pure functions in
 * `lib/playlists.ts` and writes it whole. What the dialog adds is the two
 * things a grouping inside a filtered, sorted table cannot give:
 *
 * - **The whole playlist at once.** The table shows what the filter left over,
 *   so "move this to the top" is a move relative to rows that may not be there.
 * - **The entries the loaded library has no row for.** `buildPlaylistGroups`
 *   skips them, so a playlist that says "12 tracks" shows 9 and there is
 *   nothing to reconcile it against. They are not deleted files — the schema
 *   cascades those away — but tracks in another library folder.
 */
export default function PlaylistEditor({
  playlist,
  rows,
  onRename,
  onStep,
  onRemove,
  onDelete,
  onClose,
}: Props) {
  const [confirming, setConfirming] = useState(false);

  // The field shows the *stored* name, not the typed one. `usePlaylists.rename`
  // drops an empty name as a cancelled edit and swallows a refused write, so an
  // uncontrolled field would keep showing something the playlist is not called
  // — while the group head behind the dialog, and the delete button below it,
  // still said the old name.
  const [name, setName] = useState(playlist.name);
  useEffect(() => setName(playlist.name), [playlist.name]);

  // Escape blurs, and a blur commits — but `setName` has not been applied yet
  // when the blur handler runs, so the cancellation has to travel in something
  // that changes now rather than on the next render.
  const cancelled = useRef(false);

  const commitName = () => {
    const next = cancelled.current ? "" : name.trim();
    cancelled.current = false;
    // Back to the stored name either way; a rename that lands comes back
    // through the reload as a new `playlist.name`.
    setName(playlist.name);
    if (next && next !== playlist.name) onRename(next);
  };

  return (
    <Overlay>
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-3">
          {/* The name is edited where it is shown, as it is on the group head:
              one field does not need a dialog inside a dialog. */}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              // Escape restores first, so the blur that follows has nothing
              // left to commit — the same "an empty field is a cancelled edit"
              // rule the rest of the app follows.
              if (e.key === "Escape") {
                cancelled.current = true;
                setName(playlist.name);
                e.currentTarget.blur();
              }
            }}
            className="h-9 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-2 text-sm hover:border-border focus:border-accent-500 focus:bg-surface-2 focus:outline-none"
            aria-label="Playlist name"
          />
          <span className="shrink-0 text-sm text-fg-subtle">
            {rows.length === 1 ? "1 track" : `${rows.length} tracks`}
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
          {rows.length === 0 ? (
            <p className="font-sans text-sm text-fg-subtle">
              This playlist is empty. Select tracks in the library and use
              &ldquo;Add to playlist&rdquo;.
            </p>
          ) : (
            <ol className="flex flex-col gap-1">
              {rows.map((row) => (
                <li
                  key={row.path}
                  className="group flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2"
                >
                  <span className="w-6 shrink-0 text-right text-xs text-fg-subtle">
                    {row.position}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={`truncate text-sm ${row.outsideLibrary ? "text-fg-subtle" : "text-fg"}`}
                      title={row.path}
                    >
                      {row.title}
                    </p>
                    <p className="truncate text-xs text-fg-subtle">
                      {/* The file is intact — it belongs to another library
                          folder — so this says where it is, not that it is
                          gone. Struck-through text next to a remove button
                          would invite throwing away a membership that is
                          still good. */}
                      {row.outsideLibrary
                        ? "In another library folder"
                        : row.artist || "—"}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => onStep(row.path, -1)}
                      disabled={row.position === 1}
                      className="flex h-9 w-9 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-accent-400 disabled:text-fg-disabled"
                      title="Move up in the playlist"
                      aria-label={`Move “${row.title}” up`}
                    >
                      ↑
                    </button>
                    <button
                      onClick={() => onStep(row.path, 1)}
                      disabled={row.position === rows.length}
                      className="flex h-9 w-9 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-accent-400 disabled:text-fg-disabled"
                      title="Move down in the playlist"
                      aria-label={`Move “${row.title}” down`}
                    >
                      ↓
                    </button>
                    <button
                      onClick={() => onRemove(row.path)}
                      className="flex h-9 w-9 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-danger-500"
                      title="Remove from this playlist (the file stays)"
                      aria-label={`Remove “${row.title}” from the playlist`}
                    >
                      −
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-border px-5 py-3">
          {/* Same shape as the group head's menu: it asks once, and it says what
              it does not touch, because that is the fear a Delete next to a list
              of somebody's music produces. */}
          {confirming ? (
            <button
              onClick={() => {
                onDelete();
                onClose();
              }}
              className="h-9 inline-flex items-center justify-center rounded-md border border-danger-500 px-3 text-sm text-danger-500 hover:bg-danger-500/10"
            >
              Delete “{playlist.name}”? The files stay.
            </button>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="h-9 inline-flex items-center gap-1.5 justify-center rounded-md border border-border-strong px-3 text-sm hover:border-danger-500 hover:text-danger-500"
            >
              <TrashIcon />
              Delete playlist
            </button>
          )}
          <button
            onClick={onClose}
            className="h-9 inline-flex items-center justify-center rounded-md bg-accent-600 px-4 text-sm font-medium hover:bg-accent-500"
          >
            Done
          </button>
        </footer>
      </div>
    </Overlay>
  );
}
