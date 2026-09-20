import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import AppHeader from "./AppHeader";
import { TrashIcon } from "./icons";
import { playlistRows } from "../lib/playlists";
import type { Edits } from "../lib/grouping";
import type { Playlists } from "../lib/usePlaylists";
import type { Playlist, TrackAnalysis } from "../types";
import type { PlaylistRow } from "../lib/playlists";

interface Props {
  playlists: Playlists;
  /** The library's tracks, for turning stored paths into names. */
  tracks: TrackAnalysis[];
  /** Pending, unwritten edits — read here, never written. */
  edits: Edits;
  /** Shared header navigation. */
  nav?: ReactNode;
  onTitleClick?: () => void;
}

/**
 * Playlists, as a place rather than as a way of folding the library.
 *
 * It was one of five groupings until 0.10.0, and it inherited three things from
 * the table that were never meant for it: a search and a filter that hide rows
 * of a list whose whole content is its order, sort headers that claimed to
 * sort it, and an "Unsorted" bucket that existed only because a grouping has to
 * account for every row. A view has none of those duties.
 *
 * **It is about order.** Reorder, rename, remove, delete. There is no selection
 * and no bulk action here — editing tags, converting and deleting files are the
 * library's job, where the filter and the columns are, and a second selection
 * model beside that one would be more chrome than this removed.
 *
 * Playlist state is `App`'s (`usePlaylists`), shared with the library view, so
 * a track added over there is here without a reload.
 */
export default function PlaylistsView({
  playlists,
  tracks,
  edits,
  nav,
  onTitleClick,
}: Props) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");

  // Looked up rather than held: the open playlist can be deleted here or
  // dropped by a reload, and a stale object would keep rendering a name that
  // no longer exists.
  const open = playlists.all.find((p) => p.id === openId) ?? null;

  // Something is always open when there is anything to open, so "playlists
  // exist but none is picked" never reaches the screen. On a delete this lands
  // on whatever took the same index, clamped.
  useEffect(() => {
    if (open || playlists.all.length === 0) return;
    const at = Math.min(
      playlists.all.length - 1,
      Math.max(0, playlists.all.findIndex((p) => p.id === openId)),
    );
    setOpenId(playlists.all[at].id);
  }, [open, openId, playlists.all]);

  const rows = useMemo(() => {
    if (!open) return [];
    const known = new Map(
      tracks.map((t) => {
        const m = edits[t.id]?.metadata ?? t.metadata;
        return [
          t.path,
          { title: m.title || t.file_name, artist: m.artist || "" },
        ] as const;
      }),
    );
    return playlistRows(playlists.contents[open.id] ?? [], known);
  }, [open, playlists.contents, tracks, edits]);

  const startCreate = () => {
    setDraft(playlists.suggestName("New playlist"));
    setCreating(true);
  };

  const commitCreate = () => {
    const name = draft.trim();
    setCreating(false);
    if (!name) return;
    void playlists.create(name).then((id) => {
      // The new one opens: it is empty, and the next thing anyone does with it
      // is put something in it from the library.
      if (id != null) setOpenId(id);
    });
  };

  return (
    <>
      <AppHeader title="Playlists" onTitleClick={onTitleClick} right={nav} />
      <main className="flex w-full items-start gap-6 px-6 py-6">
        {/* The page scrolls, as everywhere else in this app — only the list of
            playlists scrolls on its own, and only when there are more of them
            than fit. A pane with its own scrollbar would be the app's first,
            and would leave the back-to-top button pointing at the wrong
            thing. */}
        {/* As wide as what is in it and no wider — the button sets the floor,
            a long playlist name pushes against the cap and then truncates. The
            list beside it takes the rest of the window. */}
        <aside className="sticky top-16 flex h-[calc(100vh-4rem)] w-fit max-w-64 shrink-0 flex-col gap-2 border-r border-border pr-4 pt-6">
          <p className="px-3 text-xs text-fg-subtle">
            {playlists.all.length === 1
              ? "1 playlist"
              : `${playlists.all.length} playlists`}
          </p>

          {creating ? (
            <input
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitCreate();
                if (e.key === "Escape") setCreating(false);
              }}
              className="h-9 w-full min-w-0 rounded-md border border-accent-500 bg-surface-2 px-2 text-sm"
              aria-label="New playlist name"
            />
          ) : (
            <button
              onClick={startCreate}
              className="h-9 inline-flex w-full items-center justify-center rounded-md border border-border-strong px-3 text-sm hover:border-accent-500 hover:text-fg-accent"
            >
              New playlist…
            </button>
          )}

          <ul
            aria-label="Playlists"
            className="-mr-2 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-2"
          >
            {playlists.all.map((p) => (
              <li key={p.id}>
                <button
                  onClick={() => setOpenId(p.id)}
                  aria-current={p.id === open?.id ? "true" : undefined}
                  className={`h-9 flex w-full items-center justify-between gap-2 rounded-md px-3 text-left text-sm ${
                    p.id === open?.id
                      ? "bg-accent-600/20 text-fg-accent"
                      : "text-fg-muted hover:bg-surface-2 hover:text-fg"
                  }`}
                >
                  <span className="min-w-0 truncate">{p.name}</span>
                  {/* The stored contents first: `track_count` only refreshes on
                      a reload, so during the optimistic window after a remove
                      it would disagree with the list beside it. */}
                  <span className="shrink-0 text-xs tabular-nums text-fg-subtle">
                    {playlists.contents[p.id]?.length ?? p.track_count}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </aside>

        <section className="min-w-0 flex-1">
          {!playlists.loaded ? null : open ? (
            // Keyed by the playlist: switching must drop a half-typed rename,
            // an armed delete and any drag. A reorder does not change the id,
            // so a drag in flight is never remounted under itself.
            <OpenPlaylist key={open.id} playlists={playlists} open={open} rows={rows} />
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-surface py-20 text-center text-fg-subtle">
              <p className="text-lg text-fg-muted">No playlists yet</p>
              <p className="max-w-md font-sans text-sm">
                A playlist is an order you make. Name one here, then select
                tracks in the library and use &ldquo;Add to playlist&rdquo;.
              </p>
              <button
                onClick={startCreate}
                className="h-9 inline-flex items-center justify-center mt-2 rounded-md bg-accent-600 px-4 text-sm font-medium text-white hover:bg-accent-500"
              >
                New playlist
              </button>
            </div>
          )}
        </section>
      </main>
    </>
  );
}

/**
 * One playlist: its name, its order, and the three ways to change it.
 *
 * This is `PlaylistEditor` grown up. It was a dialog because a *grouping*
 * could not show a playlist whole — the table drew what the filter left over,
 * and the positions had to be read off the stored list to stay honest. Here
 * there is no filter, so the position is the index and the dialog has nothing
 * left to be the other half of.
 *
 * Note the rows rest on the panel and hover to `surface-2`, unlike the dialog's
 * rows, which rested *on* `surface-2`. In a dialog that read as a raised body
 * on a panel; on the page it would be the hover tone, which The Well Rule
 * exists to keep resting states out of.
 */
function OpenPlaylist({
  playlists,
  open,
  rows,
}: {
  playlists: Playlists;
  open: Playlist;
  rows: PlaylistRow[];
}) {
  const [name, setName] = useState(open.name);
  const [confirming, setConfirming] = useState(false);
  const [drag, setDrag] = useState<string[] | null>(null);
  const [dropAt, setDropAt] = useState<{ before: string | null } | null>(null);
  // Escape restores the stored name and then blurs; the blur handler has to
  // read the ref, because `setName` has not applied yet when it runs.
  const cancelled = useRef(false);

  useEffect(() => setName(open.name), [open.name]);

  const commitName = () => {
    const next = cancelled.current ? "" : name.trim();
    cancelled.current = false;
    // Back to the stored name either way; a rename that lands comes back
    // through the reload as a new `open.name`.
    setName(open.name);
    if (next && next !== open.name) void playlists.rename(open.id, next);
  };

  const commitDrop = (before: string | null) => {
    const paths = drag;
    setDrag(null);
    setDropAt(null);
    if (!paths) return;
    void playlists.move(open.id, paths, before);
  };

  return (
    <>
      <header className="mb-4 flex items-center gap-3 border-b border-border pb-3">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              cancelled.current = true;
              setName(open.name);
              e.currentTarget.blur();
            }
          }}
          className="h-9 min-w-0 max-w-sm flex-1 rounded-md border border-transparent bg-transparent px-2 text-sm hover:border-border focus:border-accent-500 focus:bg-surface-2"
          aria-label="Playlist name"
        />
        <span className="ml-auto shrink-0 text-sm text-fg-subtle">
          {rows.length === 1 ? "1 track" : `${rows.length} tracks`}
        </span>
        {/* Asks once, and says what it does not touch — that is the fear a
            Delete next to a list of somebody's music produces. */}
        {confirming ? (
          <button
            onClick={() => {
              void playlists.remove(open.id);
              setConfirming(false);
            }}
            className="h-9 inline-flex shrink-0 items-center justify-center rounded-md border border-danger-500 px-3 text-sm text-fg-danger hover:bg-danger-500/10"
          >
            Delete “{open.name}”? The files stay.
          </button>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="h-9 inline-flex shrink-0 items-center gap-1.5 justify-center rounded-md border border-border-strong px-3 text-sm hover:border-danger-500 hover:text-fg-danger"
          >
            <TrashIcon />
            Delete playlist
          </button>
        )}
      </header>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface p-5 font-sans text-sm text-fg-subtle">
          This playlist is empty. Select tracks in the library and use
          &ldquo;Add to playlist&rdquo;.
        </p>
      ) : (
        <ol
          aria-label="Tracks in this playlist"
          className="overflow-hidden rounded-xl border border-border bg-surface"
        >
          {rows.map((row) => (
            <li
              key={row.path}
              draggable
              onDragStart={() => setDrag([row.path])}
              onDragOver={(e) => {
                e.preventDefault();
                setDropAt({ before: row.path });
              }}
              onDrop={(e) => {
                e.preventDefault();
                commitDrop(row.path);
              }}
              onDragEnd={() => {
                // Escape and a drop outside both end a drag without a drop;
                // clearing only on drop is how the accent line got left
                // painted under a row.
                setDrag(null);
                setDropAt(null);
              }}
              className={`group flex h-16 items-center gap-3 border-b border-border px-4 last:border-0 hover:bg-surface-2 ${
                dropAt?.before === row.path
                  ? "border-t-2 border-t-accent-500"
                  : ""
              }`}
            >
              <span className="w-6 shrink-0 text-right text-xs tabular-nums text-fg-subtle">
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
                  {/* The file is intact — it belongs to another library folder
                      — so this says where it is, not that it is gone. */}
                  {row.outsideLibrary
                    ? "In another library folder"
                    : row.artist || "—"}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  onClick={() => void playlists.step(open.id, row.path, -1)}
                  disabled={row.position === 1}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-fg-accent disabled:text-fg-disabled"
                  title="Move up in the playlist"
                  aria-label={`Move “${row.title}” up`}
                >
                  ↑
                </button>
                <button
                  onClick={() => void playlists.step(open.id, row.path, 1)}
                  disabled={row.position === rows.length}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-fg-subtle enabled:hover:bg-surface enabled:hover:text-fg-accent disabled:text-fg-disabled"
                  title="Move down in the playlist"
                  aria-label={`Move “${row.title}” down`}
                >
                  ↓
                </button>
                <button
                  onClick={() => void playlists.removeTracks(open.id, [row.path])}
                  className="flex h-9 w-9 items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-fg-danger"
                  title="Remove from this playlist (the file stays)"
                  aria-label={`Remove “${row.title}” from the playlist`}
                >
                  −
                </button>
              </div>
            </li>
          ))}
          {/* The end of the list, which the table had no way to offer: there a
              row could only be dropped *in front of* another, so appending was
              the ↓ button's job alone. Only while a drag is in flight, or
              every playlist ends in a dashed box. */}
          {drag && (
            <li
              aria-hidden
              onDragOver={(e) => {
                e.preventDefault();
                setDropAt({ before: null });
              }}
              onDrop={(e) => {
                e.preventDefault();
                commitDrop(null);
              }}
              className={`m-3 h-9 rounded-md border-2 border-dashed ${
                dropAt?.before === null
                  ? "border-accent-500 bg-accent-500/5"
                  : "border-border-strong"
              }`}
            />
          )}
        </ol>
      )}
    </>
  );
}
