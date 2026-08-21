import type { DuplicateGroup, TrackAnalysis, TrackEdit } from "../types";

/** Column the top-level list (collapsed albums + single tracks) is sorted by. */
/** How the library list is grouped. */
export type Grouping = "flat" | "album" | "folder" | "label" | "playlist";

/**
 * The grouping switch, in display order.
 *
 * Flat comes first and is the default: it is the plain list of everything, so
 * it is both the cheapest thing to look at and the one that always shows every
 * track as its own row. The three groupings after it fold rows away, which is a
 * choice the user makes rather than the state the app opens in.
 */
export const GROUPINGS: readonly (readonly [Grouping, string])[] = [
  ["flat", "Flat"],
  ["album", "Album"],
  ["label", "Label"],
  ["folder", "Folder"],
  // Last, and unlike the three before it this one does not fold the library
  // into a different shape — it shows an order the user made, plus everything
  // that is not in one yet.
  ["playlist", "Playlists"],
];

export const DEFAULT_GROUPING: Grouping = "flat";

export type SortKey = "title" | "artist" | "album" | "length" | "date" | "bpm";

/** Columns sorted as numbers rather than as text. */
const NUMERIC_KEYS: readonly SortKey[] = ["length", "date", "bpm"];

export function isNumericSort(key: SortKey): boolean {
  return NUMERIC_KEYS.includes(key);
}

export type SortDir = "asc" | "desc";

/** A rendered top-level entry: an album group or a loose single track. */
export type AlbumItem =
  | { type: "group"; key: string; tracks: TrackAnalysis[] }
  | { type: "track"; track: TrackAnalysis };

export type Edits = Record<string, TrackEdit>;

/** Edit-aware metadata of a track (pending edits win over the scanned tags). */
export function metaOf(t: TrackAnalysis, edits: Edits) {
  return edits[t.id]?.metadata ?? t.metadata;
}

/** Album key of a track: album tag, otherwise the parent folder name. */
export function albumOf(t: TrackAnalysis, edits: Edits): string {
  const md = metaOf(t, edits);
  if (md.album?.trim()) return md.album.trim();
  const parts = t.path.split("/");
  return parts[parts.length - 2] || "(No album)";
}

/**
 * Does the track carry a real album tag? `albumOf` falls back to the parent
 * folder name, which is a guess — this tells the two apart.
 */
export function hasAlbumTag(t: TrackAnalysis, edits: Edits): boolean {
  return !!metaOf(t, edits).album?.trim();
}

/**
 * Does this bucket of same-album tracks deserve a group header? Yes from two
 * tracks up, and also for a lone track that is genuinely tagged with an album —
 * a single or a one-track EP belongs under its album, not next to it. Tracks
 * without an album tag stay loose, otherwise every stray file would get a
 * group named after whatever folder it happens to sit in.
 */
export function isAlbumGroup(tracks: TrackAnalysis[], edits: Edits): boolean {
  return tracks.length >= 2 || tracks.some((t) => hasAlbumTag(t, edits));
}

/** Album artist of a track for the group header (falls back to artist). */
export function albumArtistOf(t: TrackAnalysis, edits: Edits): string {
  const md = metaOf(t, edits);
  return (md.album_artist ?? md.artist ?? "").trim();
}

/** Compares numeric sort values; missing (null) always last. dir: 1 asc, -1 desc. */
export function compareNumbers(
  a: number | null,
  b: number | null,
  dir: number,
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return dir * (a - b);
}

/** Compares two sort values (empty always last, numeric-aware). dir: 1 asc, -1 desc. */
export function compareValues(a: string, b: string, dir: number): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return dir * a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Edit-aware text value of a track for the active text sort column. */
function trackText(t: TrackAnalysis, edits: Edits, sortKey: SortKey): string {
  const md = metaOf(t, edits);
  switch (sortKey) {
    case "artist":
      return (md.album_artist ?? md.artist ?? "").trim();
    case "album":
      return albumOf(t, edits);
    default: // "title"
      return (md.title ?? t.file_name).trim();
  }
}

/** Edit-aware track number for the hard within-album ordering (nulls last). */
export function trackNumberOf(t: TrackAnalysis, edits: Edits): number {
  const n = metaOf(t, edits).track_number;
  return n != null ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Groups tracks by album (see `isAlbumGroup`; everything else becomes a single
 * row) and sorts the top level by the active column. Tracks within a group are
 * always hard-sorted by track number regardless of the top-level criterion.
 */
export function buildAlbumItems(
  tracks: TrackAnalysis[],
  edits: Edits,
  sortKey: SortKey,
  sortDir: SortDir,
): AlbumItem[] {
  const dir = sortDir === "asc" ? 1 : -1;
  const map = new Map<string, TrackAnalysis[]>();
  for (const t of tracks) {
    const key = albumOf(t, edits);
    const list = map.get(key);
    if (list) list.push(t);
    else map.set(key, [t]);
  }

  const items: AlbumItem[] = [];
  for (const [key, tr] of map) {
    if (isAlbumGroup(tr, edits)) {
      const sorted = [...tr].sort(
        (a, b) => trackNumberOf(a, edits) - trackNumberOf(b, edits),
      );
      items.push({ type: "group", key, tracks: sorted });
    } else {
      items.push({ type: "track", track: tr[0] });
    }
  }

  // A group's representative is its first (lowest-numbered) track; for the
  // "album" column it is the album name, for "length" the total duration and for
  // "date" the newest track's download date.
  if (isNumericSort(sortKey)) {
    const itemNum = (it: AlbumItem): number | null =>
      it.type === "group"
        ? groupNumber(it.tracks, edits, sortKey)
        : trackNumber(it.track, edits, sortKey);
    items.sort((a, b) => compareNumbers(itemNum(a), itemNum(b), dir));
  } else {
    const itemText = (it: AlbumItem): string =>
      it.type === "group"
        ? sortKey === "album"
          ? it.key.trim()
          : trackText(it.tracks[0], edits, sortKey)
        : trackText(it.track, edits, sortKey);
    items.sort((a, b) => compareValues(itemText(a), itemText(b), dir));
  }
  return items;
}

/** Flat (ungrouped) list sorted by the active column. */
export function sortTracks(
  tracks: TrackAnalysis[],
  edits: Edits,
  sortKey: SortKey,
  sortDir: SortDir,
): TrackAnalysis[] {
  const dir = sortDir === "asc" ? 1 : -1;
  return [...tracks].sort((a, b) =>
    isNumericSort(sortKey)
      ? compareNumbers(trackNumber(a, edits, sortKey), trackNumber(b, edits, sortKey), dir)
      : compareValues(trackText(a, edits, sortKey), trackText(b, edits, sortKey), dir),
  );
}

/**
 * Numeric sort value of a track. Only BPM can be null (many files carry no
 * tempo tag) — a missing download date keeps its long-standing 0, so the
 * "Added" column sorts exactly as before.
 */
export function trackNumber(
  t: TrackAnalysis,
  edits: Edits,
  key: SortKey,
): number | null {
  switch (key) {
    case "length":
      return t.audio.duration_secs;
    case "bpm":
      return metaOf(t, edits).bpm;
    default:
      return t.download_date ?? 0;
  }
}

/**
 * Numeric sort value of a whole group: summed length, newest date, or the mean
 * BPM of the tracks that have one.
 */
export function groupNumber(
  tracks: TrackAnalysis[],
  edits: Edits,
  key: SortKey,
): number | null {
  if (key === "length") {
    return tracks.reduce((s, t) => s + t.audio.duration_secs, 0);
  }
  if (key === "date") {
    return Math.max(...tracks.map((t) => t.download_date ?? 0));
  }
  const values = tracks
    .map((t) => metaOf(t, edits).bpm)
    .filter((v): v is number => v != null);
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/**
 * Removes files that are no longer valid from duplicate groups, discards groups
 * with < 2 files and corrects the keep choice. Reference-stable when nothing
 * changed.
 */
export function pruneGroups(
  groups: DuplicateGroup[],
  isValid: (path: string) => boolean,
): DuplicateGroup[] {
  let changed = false;
  const out: DuplicateGroup[] = [];
  for (const g of groups) {
    const files = g.files.filter((f) => isValid(f.path));
    if (files.length !== g.files.length) changed = true;
    if (files.length < 2) {
      changed = true;
      continue;
    }
    const keep_id = files.some((f) => f.id === g.keep_id)
      ? g.keep_id
      : files[0].id;
    if (keep_id !== g.keep_id) changed = true;
    out.push({ ...g, files, keep_id });
  }
  return changed ? out : groups;
}
