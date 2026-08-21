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
