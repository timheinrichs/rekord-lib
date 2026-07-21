import type { DuplicateGroup, TrackAnalysis, TrackEdit } from "../types";

/** Column the top-level list (collapsed albums + single tracks) is sorted by. */
export type SortKey = "title" | "artist" | "album" | "length" | "date";

export type SortDir = "asc" | "desc";

/** A rendered top-level entry: an album group (>= 2 tracks) or a single track. */
export type AlbumItem =
  | { type: "group"; key: string; tracks: TrackAnalysis[] }
  | { type: "track"; track: TrackAnalysis };

type Edits = Record<string, TrackEdit>;

/** Edit-aware metadata of a track (pending edits win over the scanned tags). */
function metaOf(t: TrackAnalysis, edits: Edits) {
  return edits[t.id]?.metadata ?? t.metadata;
}

/** Album key of a track: album tag, otherwise the parent folder name. */
export function albumOf(t: TrackAnalysis, edits: Edits): string {
  const md = metaOf(t, edits);
  if (md.album?.trim()) return md.album.trim();
  const parts = t.path.split("/");
  return parts[parts.length - 2] || "(No album)";
}

/** Album artist of a track for the group header (falls back to artist). */
export function albumArtistOf(t: TrackAnalysis, edits: Edits): string {
  const md = metaOf(t, edits);
  return (md.album_artist ?? md.artist ?? "").trim();
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
function trackNumberOf(t: TrackAnalysis, edits: Edits): number {
  const n = metaOf(t, edits).track_number;
  return n != null ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Groups tracks by album (>= 2 tracks = group, otherwise a single row) and
 * sorts the top level by the active column. Tracks within a group are always
 * hard-sorted by track number regardless of the top-level criterion.
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
    if (tr.length >= 2) {
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
  if (sortKey === "length" || sortKey === "date") {
    const itemNum = (it: AlbumItem): number =>
      it.type === "group"
        ? sortKey === "length"
          ? it.tracks.reduce((s, t) => s + t.audio.duration_secs, 0)
          : Math.max(...it.tracks.map((t) => t.download_date ?? 0))
        : trackNumber(it.track, sortKey);
    items.sort((a, b) => dir * (itemNum(a) - itemNum(b)));
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
    sortKey === "length" || sortKey === "date"
      ? dir * (trackNumber(a, sortKey) - trackNumber(b, sortKey))
      : compareValues(trackText(a, edits, sortKey), trackText(b, edits, sortKey), dir),
  );
}

/** Numeric sort value of a track for the "length" / "date" columns. */
function trackNumber(t: TrackAnalysis, key: SortKey): number {
  return key === "length" ? t.audio.duration_secs : t.download_date ?? 0;
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
