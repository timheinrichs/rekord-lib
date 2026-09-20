import type { Playlist } from "../types";

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

/** How many of `paths` a playlist would actually gain. */
export function wouldAdd(current: string[], paths: string[]): number {
  const have = new Set(current);
  let count = 0;
  const seen = new Set<string>();
  for (const path of paths) {
    if (have.has(path) || seen.has(path)) continue;
    seen.add(path);
    count += 1;
  }
  return count;
}

/** One line in the playlist editor: a stored entry, drawn or not. */
export interface PlaylistRow {
  path: string;
  /** 1-based place in the stored list. */
  position: number;
  title: string;
  artist: string;
  /**
   * The loaded library has no track for this path — see `playlistRows` for the
   * one situation that actually produces it.
   */
  outsideLibrary: boolean;
}

/**
 * Every entry of a playlist, in order, including the ones the library has no
 * row for.
 *
 * The position is simply the index, and that is worth noticing: until 0.10.0
 * a playlist was drawn by the library table, whose filter had already removed
 * some of its rows, so the place a track held had to be read off the stored
 * list to stay honest. The playlists view has no filter, so the list and the
 * screen agree by construction and there is nothing to reconcile.
 *
 * Nothing is skipped here either. A playlist that says "12 tracks" over 9 rows
 * is one nobody can make sense of, so an entry the library cannot name is kept
 * and marked.
 *
 * **What such an entry is, precisely.** Not a deleted file:
 * `playlist_items.path` references `tracks(path)` `ON DELETE CASCADE`, so a
 * track that leaves the library takes its memberships with it, and
 * `set_playlist_paths` drops a path the library does not hold rather than
 * storing it. What is left is the case the two queries disagree on —
 * `all_playlist_paths` reads every membership, `load_tracks` reads one
 * `library_dir` — a track belonging to **another library folder**, which is
 * what a folder switch without a relocate leaves behind. Those files are
 * intact, which is why the row says so rather than calling them missing, and
 * why removing one is offered as what it is: taking it out of the playlist.
 */
export function playlistRows(
  paths: string[],
  known: Map<string, { title: string; artist: string }>,
): PlaylistRow[] {
  return paths.map((path, index) => {
    const track = known.get(path);
    return {
      path,
      position: index + 1,
      title: track?.title || path.split("/").pop() || path,
      artist: track?.artist ?? "",
      outsideLibrary: !track,
    };
  });
}
