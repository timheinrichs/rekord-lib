import { useState } from "react";
import { useDismiss } from "../lib/useDismiss";
import type { Playlist } from "../types";

interface Props {
  playlist: Playlist;
  onRename: (name: string) => void;
  onDelete: () => void;
}

/**
 * What can be done to a whole playlist, on its group head.
 *
 * Renaming happens in place rather than in a dialog: the name is one field and
 * the head is where it already is, so a modal would be a second window for a
 * word. Deleting asks first — it is the one action here that cannot be undone,
 * and unlike a track it takes no files with it, which is exactly why it is easy
 * to do by accident.
 */
export default function PlaylistMenu({ playlist, onRename, onDelete }: Props) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => {
    setOpen(false);
    setConfirming(false);
  });

  if (renaming) {
    return (
      <input
        autoFocus
        defaultValue={playlist.name}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => {
          setRenaming(false);
          onRename(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          // Escape leaves the name alone, which is what an empty field means
          // everywhere else in this app too.
          if (e.key === "Escape") {
            e.currentTarget.value = playlist.name;
            e.currentTarget.blur();
          }
        }}
        className="w-40 rounded-md border border-accent-500 bg-surface-2 px-2 py-1 text-sm outline-none"
        aria-label="Playlist name"
      />
    );
  }

  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 w-8 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-accent-400"
        title={`Actions for “${playlist.name}”`}
        aria-label="Playlist actions"
      >
        ⋮
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 rounded-lg border border-border bg-surface-2 py-1 shadow-2xl">
          <button
            onClick={() => {
              setOpen(false);
              setRenaming(true);
            }}
            className="h-9 inline-flex items-center justify-center block w-full px-3 text-left text-sm hover:bg-surface hover:text-accent-400"
          >
            Rename
          </button>
          {confirming ? (
            <button
              onClick={() => {
                setOpen(false);
                setConfirming(false);
                onDelete();
              }}
              className="h-9 inline-flex items-center justify-center block w-full px-3 text-left text-sm text-danger-500 hover:bg-surface"
            >
              Delete “{playlist.name}”?
            </button>
          ) : (
            <button
              onClick={() => setConfirming(true)}
              className="h-9 inline-flex items-center justify-center block w-full px-3 text-left text-sm hover:bg-surface hover:text-danger-500"
            >
              Delete
            </button>
          )}
          {/* Said plainly, because it is the thing people fear when they see
              Delete next to a list of their music. */}
          <p className="px-3 pt-1 font-sans text-xs text-fg-subtle">
            Deleting a playlist keeps every file.
          </p>
        </div>
      )}
    </div>
  );
}
