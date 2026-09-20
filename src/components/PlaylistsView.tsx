import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import AppHeader from "./AppHeader";
import { GripIcon, TrashIcon } from "./icons";
import CoverThumb from "./CoverThumb";
import RowWaveform from "./RowWaveform";
import {
  playlistColumns,
  type ColumnDef,
  type ColumnId,
} from "../lib/columns";
import { formatBpm, formatDuration, formatKey } from "../lib/format";
import { metaOf } from "../lib/grouping";
import { usePlayer, type PlayerTrack } from "../lib/player";
import { gapIndexAt, playlistRows, reorderAt } from "../lib/playlists";
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
  /** The columns the user has switched off, shared with the library table. */
  hiddenColumns: readonly ColumnId[];
  /**
   * Whether this is the view on screen. Every view stays mounted so a scan
   * survives navigation, which means a hidden one still re-renders on every
   * batch — and this one reads the whole library to name its rows.
   */
  active: boolean;
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
  hiddenColumns,
  active,
  nav,
  onTitleClick,
}: Props) {
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");

  // Derived, never held: the open playlist can be deleted here or dropped by a
  // reload, and a stale object would keep rendering a name that no longer
  // exists. Falling back to the first is also what makes "playlists exist but
  // none is picked" unreachable — and it is derived during render rather than
  // chosen in an effect, because an effect paints the empty state over a full
  // list for one frame first.
  const open =
    playlists.all.find((p) => p.id === openId) ?? playlists.all[0] ?? null;

  const cols = useMemo(() => playlistColumns(hiddenColumns), [hiddenColumns]);

  /**
   * The library by path, which every column but the position and the title
   * needs.
   *
   * Gated on `active`, and that is not an optimisation for its own sake: every
   * view stays mounted, `tracks` changes about four times a second during a
   * scan, and without the gate a hidden screen would rebuild a map of the whole
   * library on each batch. The memo this replaced was gated too — by the dialog
   * being open — and losing that silently is how the cost would have arrived.
   */
  const byPath = useMemo(
    () => (active ? new Map(tracks.map((t) => [t.path, t])) : new Map()),
    [active, tracks],
  );

  const rows = useMemo(() => {
    if (!open || !active) return [];
    const known = new Map(
      [...byPath.values()].map((t) => {
        const m = edits[t.id]?.metadata ?? t.metadata;
        return [
          t.path,
          { title: m.title || t.file_name, artist: m.artist || "" },
        ] as const;
      }),
    );
    return playlistRows(playlists.contents[open.id] ?? [], known);
  }, [open, active, playlists.contents, byPath, edits]);

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
      <main className="flex w-full items-start gap-6 px-6 pb-6">
        {/* The page scrolls, as everywhere else in this app — only the list of
            playlists scrolls on its own, and only when there are more of them
            than fit. A pane with its own scrollbar would be the app's first,
            and would leave the back-to-top button pointing at the wrong
            thing. */}
        {/* A fixed 270 px, and everything in it the full width of that: a
            column that resized itself around the longest playlist name moved
            the track list every time one was renamed. The list beside it takes
            the rest of the window. */}
        <aside className="sticky top-16 flex h-[calc(100vh-4rem)] w-[270px] shrink-0 flex-col gap-2 border-r border-border pr-4 pt-6">
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
              // Clicking away abandons it rather than creating something
              // nobody asked for: the field opens pre-filled with a suggested
              // name, so a blur that committed would make "New playlist" out
              // of a mis-aimed click.
              onBlur={() => setCreating(false)}
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

        <section className="min-w-0 flex-1 pt-6">
          {!playlists.loaded ? null : open ? (
            // Keyed by the playlist: switching must drop a half-typed rename,
            // an armed delete and any drag. A reorder does not change the id,
            // so a drag in flight is never remounted under itself.
            <OpenPlaylist
              key={open.id}
              playlists={playlists}
              open={open}
              rows={rows}
              cols={cols}
              byPath={byPath}
              edits={edits}
            />
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
  cols,
  byPath,
  edits,
}: {
  playlists: Playlists;
  open: Playlist;
  rows: PlaylistRow[];
  cols: ColumnDef[];
  /** The library's tracks by path, for the columns a stored path cannot fill. */
  byPath: Map<string, TrackAnalysis>;
  edits: Edits;
}) {
  const [name, setName] = useState(open.name);
  const [confirming, setConfirming] = useState(false);
  /** How far a press has to travel before it is a drag and not a click. */
  const DRAG_THRESHOLD = 4;

  /** The row being carried, and where the press began — for the threshold. */
  const [drag, setDrag] = useState<{ path: string; from: number } | null>(null);
  /**
   * The order on screen while a row is being carried, or `null` when it is the
   * stored one.
   *
   * The preview *is* the interaction: the row moves to where it would land
   * rather than a line being drawn where it would go, so what is dropped is
   * exactly what was already on screen. It is also why the geometry below is
   * read against this order rather than the stored one — the pointer can only
   * mean something about the rows it is actually over.
   */
  const [preview, setPreview] = useState<string[] | null>(null);
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

  /**
   * The actions column is `w-16` in the library, where the row actions live in
   * a patch that fades in over the cells. Here the three buttons are always
   * there, so the column has to be as wide as they are.
   */
  const widthOf = (c: ColumnDef) => (c.id === "actions" ? "w-32" : (c.width ?? ""));

  const cell = (c: ColumnDef, row: PlaylistRow) => {
    const track = byPath.get(row.path);
    const pad = c.tight ? "px-1 py-0" : "px-4 py-0";
    switch (c.id) {
      case "expand":
        // Where the chevron sits in the library. A playlist row has nothing to
        // expand and the number is what the row *is*.
        return (
          <td
            key={c.id}
            className={`${pad} text-right text-xs tabular-nums text-fg-subtle`}
          >
            {row.position}
          </td>
        );
      case "cover":
        return (
          <td key={c.id} className={pad}>
            {track && (
              <CoverThumb
                path={track.path}
                hasCover={track.metadata.has_cover}
                onPlay={() => playFrom(track.path)}
                active={player.current?.path === track.path}
                playing={player.playing}
                onToggle={player.toggle}
              />
            )}
          </td>
        );
      case "waveform":
        return (
          <td key={c.id} className={pad}>
            {track && <RowWaveform path={track.path} />}
          </td>
        );
      case "title":
        return (
          <td key={c.id} className={pad}>
            <p
              className={`truncate text-sm ${row.outsideLibrary ? "text-fg-subtle" : "text-fg"}`}
              title={row.path}
            >
              {row.title}
            </p>
            {/* The file is intact — it belongs to another library folder — so
                this says where it is, not that it is gone. */}
            {row.outsideLibrary && (
              <p className="truncate text-xs text-fg-subtle">
                In another library folder
              </p>
            )}
          </td>
        );
      case "artist":
        return (
          <td key={c.id} className={`truncate ${pad} text-fg-muted`}>
            {row.artist || "—"}
          </td>
        );
      case "album":
        return (
          <td key={c.id} className={`truncate ${pad} text-fg-muted`}>
            {track ? metaOf(track, edits).album || "—" : ""}
          </td>
        );
      case "length":
        return (
          <td key={c.id} className={`whitespace-nowrap ${pad} text-fg-muted`}>
            {track ? formatDuration(track.audio.duration_secs) : ""}
          </td>
        );
      case "bpm":
        return (
          <td key={c.id} className={`whitespace-nowrap ${pad} text-fg-muted`}>
            {track ? formatBpm(metaOf(track, edits).bpm) : ""}
          </td>
        );
      case "key":
        return (
          <td key={c.id} className={`whitespace-nowrap ${pad} text-fg-muted`}>
            {track ? formatKey(track.key) : ""}
          </td>
        );
      case "actions":
        return (
          <td key={c.id} className={pad}>
            <div className="flex items-center justify-end gap-1">
              {/* The one place a row is picked up, so the grab cursor is on a
                  handle rather than on everything. It is a button and it is
                  operable from the keyboard: HTML5 drag has no auto-scroll and
                  a pointer gesture has no keyboard equivalent at all, so
                  without the arrow keys here a long playlist could not be
                  reordered without a mouse. */}
              <button
                onPointerDown={(e) => beginDrag(e, row)}
                onKeyDown={(e) => {
                  if (e.key === "ArrowUp" && row.position > 1) {
                    e.preventDefault();
                    void playlists.step(open.id, row.path, -1);
                  }
                  if (e.key === "ArrowDown" && row.position < rows.length) {
                    e.preventDefault();
                    void playlists.step(open.id, row.path, 1);
                  }
                }}
                className="flex h-9 w-9 cursor-grab items-center justify-center rounded-md text-fg-subtle hover:bg-surface hover:text-fg-accent"
                title="Drag to reorder, or use the arrow keys"
                aria-label={`Reorder “${row.title}”`}
              >
                <GripIcon />
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
          </td>
        );
      default:
        return <td key={c.id} className={pad} />;
    }
  };

  /** The stored order, which is what a drop is expressed against. */
  const paths = rows.map((r) => r.path);

  const player = usePlayer();

  /**
   * The playlist as a queue, in its order — which is the whole point of
   * playing from here rather than from the library. Entries the library has no
   * track for drop out; they have nothing to play.
   */
  const queue = rows
    .map((r) => byPath.get(r.path))
    .filter((t): t is TrackAnalysis => !!t)
    .map((t): PlayerTrack => {
      const m = edits[t.id]?.metadata ?? t.metadata;
      return {
        id: t.id,
        path: t.path,
        title: m.title || t.file_name,
        artist: m.artist || m.album_artist || "",
        album: m.album || "",
      };
    });

  const playFrom = (path: string) => {
    const i = queue.findIndex((q) => q.path === path);
    // `positioned`: in a playlist "track 3 of 12" is a fact about the set the
    // user made, which is exactly when the player should show it.
    if (i >= 0) player.play(queue, i, true);
  };

  /**
   * The rows as they are on screen: the preview while a row is carried, the
   * stored order otherwise. Positions are renumbered with it, because a
   * playlist's numbers are what the order *is* — leaving them behind would
   * show a list that disagrees with itself mid-drag.
   */
  const shown = useMemo(() => {
    if (!preview) return rows;
    const byRow = new Map(rows.map((r) => [r.path, r]));
    return preview.flatMap((p, i) => {
      const row = byRow.get(p);
      return row ? [{ ...row, position: i + 1 }] : [];
    });
  }, [preview, rows]);

  const body = useRef<HTMLTableSectionElement>(null);
  const boxes = () =>
    [...(body.current?.children ?? [])].map((el) =>
      el.getBoundingClientRect(),
    );

  const beginDrag = (
    e: React.PointerEvent<HTMLButtonElement>,
    row: PlaylistRow,
  ) => {
    if (e.button !== 0) return;
    // Stops the text selection the gesture would otherwise begin.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ path: row.path, from: e.clientY });
  };

  const moveDrag = (y: number) => {
    if (!drag) return;
    // A press that has not travelled is a click, not a drag.
    if (Math.abs(y - drag.from) < DRAG_THRESHOLD) return;
    const shown = preview ?? paths;
    setPreview(reorderAt(shown, drag.path, gapIndexAt(boxes(), y)));
  };

  const endDrag = (commit: boolean) => {
    const moving = drag;
    const order = preview;
    setDrag(null);
    setPreview(null);
    // No preview means the press never travelled: a click, not a drag.
    if (!commit || !moving || !order) return;
    // The write is expressed against the stored list, so the order on screen is
    // turned back into "before which path" — the one that follows it there, or
    // the end.
    const i = order.indexOf(moving.path);
    void playlists.move(open.id, [moving.path], order[i + 1] ?? null);
  };

  return (
    <>
      <header className="mb-4 flex items-center gap-3">
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
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <table className="w-full table-fixed">
            <thead>
              <tr className="h-10 border-b border-border text-left text-xs text-fg-subtle">
                {cols.map((c) => (
                  <th
                    key={c.id}
                    className={`${widthOf(c)} ${c.tight ? "px-1" : "px-4"} font-normal ${
                      c.id === "expand" ? "text-right" : ""
                    }`}
                  >
                    {/* Named, never sortable: the order is the content, and a
                        header that invited a sort here would be offering to
                        destroy the thing the view is for. */}
                    {c.id === "expand" ? "#" : c.label}
                  </th>
                ))}
              </tr>
            </thead>
            {/* Nothing is selectable while a row is being carried: a pointer
                drawn across table cells selects their text, which painted the
                rows the drag passed over in the selection colour. Only while
                dragging, so a title can still be copied the rest of the
                time. */}
            <tbody
              ref={body}
              aria-label="Tracks in this playlist"
              className={drag ? "cursor-grabbing select-none" : ""}
            >
              {shown.map((row, i) => {
                const last = i === shown.length - 1;
                return (
                  <tr
                    key={row.path}
                    onPointerMove={(e) => {
                      if (drag?.path !== row.path) return;
                      moveDrag(e.clientY);
                    }}
                    onPointerUp={() => endDrag(true)}
                    onPointerCancel={() => endDrag(false)}
                    // The row being carried is translucent and already where
                    // it would land: the list reorders under the pointer, so
                    // there is nothing to indicate and nothing to imagine.
                    className={`group h-16 border-b border-border hover:bg-surface-2 ${
                      drag?.path === row.path ? "opacity-40" : ""
                    } ${last ? "border-b-0" : ""}`}
                  >
                    {cols.map((c) => cell(c, row))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

    </>
  );
}
