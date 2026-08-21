import type { Playlist, TrackAnalysis } from "../types";

/**
 * What a playlist's order does when somebody edits it.
 *
 * All of it is pure and all of it works on the list of paths, because that is
 * what the backend stores: `playlist_set` replaces a playlist's contents with
 * exactly the array it is given, in exactly that order. So every operation here
 * answers one question — what should the new list be — and the caller writes the
 * answer back whole.
 *
 * A diff would be the other design, and it is the wrong one here: the order is
 * the payload, a single reorder changes most of the positions anyway, and a
 * playlist is tens or hundreds of rows rather than the scale where a diff earns
 * its complexity.
 */

/** Adds `paths` to the end, skipping the ones already in the list. */
export function addToPlaylist(current: string[], paths: string[]): string[] {
  const have = new Set(current);
  const added: string[] = [];
  for (const path of paths) {
    // A track appearing twice in one playlist is a different feature (and one
    // Rekordbox supports); until something asks for it, adding a track that is
    // already there is a no-op rather than a duplicate row nobody meant. The
    // set grows as we go, so a duplicate *within* `paths` is caught too.
    if (have.has(path)) continue;
    have.add(path);
    added.push(path);
  }
  return added.length ? [...current, ...added] : current;
}

/** Removes every path in `paths`. */
export function removeFromPlaylist(
  current: string[],
  paths: string[],
): string[] {
  const gone = new Set(paths);
  return current.filter((p) => !gone.has(p));
}

/**
 * Moves the track at `from` so that it sits at index `to` in the result.
 *
 * Index-based rather than "swap with the neighbour", because that is what drag
 * and drop produces and because move-up/move-down are then the same operation
 * with `to = from ∓ 1` — one rule to get right instead of three.
 *
 * Out-of-range indices return the list unchanged: a drop outside the list and a
 * move-up on the first row are the same non-event, and neither is worth an
 * error.
 */
export function movePlaylistItem(
  current: string[],
  from: number,
  to: number,
): string[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= current.length ||
    to >= current.length
  ) {
    return current;
  }
  const next = [...current];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Moves everything in `paths` so it sits directly before `before` — the
 * multi-row drag.
 *
 * The selection keeps its own relative order rather than the order it was
 * clicked in: what the user sees on screen is what they are dragging, and any
 * other rule would shuffle rows they never touched. `before === null` drops at
 * the end.
 */
export function movePlaylistItems(
  current: string[],
  paths: string[],
  before: string | null,
): string[] {
  const moving = new Set(paths);
  const block = current.filter((p) => moving.has(p));
  if (!block.length) return current;
  const rest = current.filter((p) => !moving.has(p));
  // The anchor may itself be part of the block — dropping a selection onto one
  // of its own rows means "leave it where it is".
  const at = before === null || moving.has(before) ? -1 : rest.indexOf(before);
  if (at < 0) {
    return before === null ? [...rest, ...block] : current;
  }
  return [...rest.slice(0, at), ...block, ...rest.slice(at)];
}

/**
 * A name that is not already taken, by appending a number.
 *
 * Duplicate names are not forbidden by the database — two playlists really can
 * be called "Set" — but offering the same name twice by default is how a user
 * ends up with two of something they meant to have one of.
 */
export function uniquePlaylistName(existing: Playlist[], base: string): string {
  const trimmed = base.trim() || "Playlist";
  const taken = new Set(existing.map((p) => p.name.toLowerCase()));
  if (!taken.has(trimmed.toLowerCase())) return trimmed;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${trimmed} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return trimmed;
}

/**
 * Moves one track a step through the playlist.
 *
 * Expressed with the same "put it in front of that one" rule the drag uses, so
 * the two ways of reordering cannot drift apart. The catch is the direction:
 * the track is lifted out before it is put back, so moving *down* has to aim
 * one row further along than it looks — off by one here and a track swaps with
 * itself, which reads as a button that does nothing.
 */
export function stepPlaylistItem(
  current: string[],
  path: string,
  step: -1 | 1,
): string[] {
  const index = current.indexOf(path);
  if (index < 0) return current;
  // Already at the end it can move to. Returning the same list rather than an
  // identical copy is what lets the caller skip the write — a button at the top
  // of a playlist should cost nothing at all when it is pressed anyway.
  if ((step < 0 && index === 0) || (step > 0 && index === current.length - 1)) {
    return current;
  }
  const target = index + step + (step > 0 ? 1 : 0);
  const before = target >= current.length ? null : current[target];
  return movePlaylistItems(current, [path], before);
}

/** Key of the bucket holding everything that is in no playlist. */
export const UNSORTED_ID = -1;

/** One head in the playlists grouping, with the tracks under it. */
export interface PlaylistGroup {
  /** The playlist, or null for the unsorted bucket. */
  playlist: Playlist | null;
  /** Stable expand key, and what the drag handlers key off. */
  id: number;
  name: string;
  /** In playlist order for a real playlist; in list order for unsorted. */
  tracks: TrackAnalysis[];
}

/**
 * The playlists grouping: one group per playlist, in the order they were made,
 * plus everything that is in none of them.
 *
 * Two things it has to get right, and both come from the same place — the
 * playlist stores *paths*, and the table shows the tracks the filter left over:
 *
 * - **Order comes from the playlist, not from the sort.** Every other grouping
 *   sorts its rows; this one must not, because the order is the content. That is
 *   also why the position is worth a column.
 * - **A path with no visible track is skipped, not drawn empty.** It may be
 *   filtered out, or the file may be gone and the row already pruned. Either
 *   way there is nothing to show, and the count reflects what is on screen.
 */
export function buildPlaylistGroups(
  playlists: Playlist[],
  contents: Record<number, string[]>,
  tracks: TrackAnalysis[],
): PlaylistGroup[] {
  const byPath = new Map(tracks.map((t) => [t.path, t]));
  const spoken = new Set<string>();

  const groups: PlaylistGroup[] = playlists.map((playlist) => {
    const paths = contents[playlist.id] ?? [];
    const inOrder: TrackAnalysis[] = [];
    for (const path of paths) {
      const track = byPath.get(path);
      if (!track) continue;
      inOrder.push(track);
      spoken.add(path);
    }
    return {
      playlist,
      id: playlist.id,
      name: playlist.name,
      tracks: inOrder,
    };
  });

  // Always present, even when empty: it is where a track lands when it is taken
  // out of a playlist, and a bucket that appears only sometimes is a bucket
  // nobody learns to look in.
  groups.push({
    playlist: null,
    id: UNSORTED_ID,
    name: "Unsorted",
    tracks: tracks.filter((t) => !spoken.has(t.path)),
  });
  return groups;
}
