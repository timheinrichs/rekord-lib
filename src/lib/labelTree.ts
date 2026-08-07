import type { TrackAnalysis } from "../types";
import {
  albumOf,
  compareNumbers,
  compareValues,
  groupNumber,
  isNumericSort,
  metaOf,
  trackNumberOf,
  type Edits,
  type SortDir,
  type SortKey,
} from "./grouping";

/** Key of the bucket for tracks without a label tag (always sorted last). */
export const NO_LABEL_KEY = "";

/** Display name of that bucket. */
export const NO_LABEL = "(No label)";

/** Albums with at least this many tracks get their own header inside a label. */
const MIN_ALBUM_SIZE = 2;

/**
 * Stable expand key. JSON-encoded so that a label or album name containing the
 * separator cannot collide with another node ("A" + "B:C" vs "A:B" + "C").
 */
function nodeId(kind: "label" | "album", ...parts: string[]): string {
  return JSON.stringify([kind, ...parts]);
}

/** An album inside a label group. */
export interface LabelAlbumNode {
  /** Stable expand key (unique across labels). */
  id: string;
  album: string;
  tracks: TrackAnalysis[];
}

/** A record label with its albums and its single-track leftovers. */
export interface LabelNode {
  /** Stable expand key. */
  id: string;
  /** Raw label key; `NO_LABEL_KEY` when the label tag is missing. */
  key: string;
  /** Display name (`NO_LABEL` for the unknown bucket). */
  name: string;
  /** Albums with >= 2 tracks under this label. */
  albums: LabelAlbumNode[];
  /** Tracks whose album has only one track under this label. */
  tracks: TrackAnalysis[];
  /** Every track of the label, in render order (albums first, then loose). */
  all: TrackAnalysis[];
}

/**
 * Record label of a track. Unlike `albumOf` there is no path fallback — a
 * missing label is genuinely unknown and lands in the `NO_LABEL_KEY` bucket.
 */
export function labelOf(t: TrackAnalysis, edits: Edits): string {
  return metaOf(t, edits).label?.trim() ?? NO_LABEL_KEY;
}

/** Natural, case-insensitive compare (so "EP 2" sorts before "EP 10"). */
function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Edit-aware display title of a track (falls back to the file name). */
function titleOf(t: TrackAnalysis, edits: Edits): string {
  return (metaOf(t, edits).title ?? t.file_name).trim();
}

/** Orders tracks within an album by track number (nulls last), then title. */
function sortAlbumTracks(tracks: TrackAnalysis[], edits: Edits): TrackAnalysis[] {
  return [...tracks].sort((a, b) => {
    const na = trackNumberOf(a, edits);
    const nb = trackNumberOf(b, edits);
    if (na !== nb) return na - nb;
    return byName(titleOf(a, edits), titleOf(b, edits));
  });
}

/** Numeric sort value of a whole label (summed length, newest date, mean BPM). */
function labelNumber(node: LabelNode, edits: Edits, sortKey: SortKey): number | null {
  return groupNumber(node.all, edits, sortKey);
}

/**
 * Groups tracks by record label and, inside each label, by album. Albums with a
 * single track stay loose so a lone track does not get a header of its own.
 * Every label gets a node — even with one track — because when browsing by
 * label the label list itself is the information. The `NO_LABEL_KEY` bucket is
 * always last, regardless of column and direction. Pure.
 */
export function buildLabelTree(
  tracks: TrackAnalysis[],
  edits: Edits,
  sortKey: SortKey,
  sortDir: SortDir,
): LabelNode[] {
  const dir = sortDir === "asc" ? 1 : -1;

  // label key -> album key -> tracks
  const byLabel = new Map<string, Map<string, TrackAnalysis[]>>();
  for (const t of tracks) {
    const key = labelOf(t, edits);
    let albums = byLabel.get(key);
    if (!albums) {
      albums = new Map();
      byLabel.set(key, albums);
    }
    const album = albumOf(t, edits);
    const list = albums.get(album);
    if (list) list.push(t);
    else albums.set(album, [t]);
  }

  const nodes: LabelNode[] = [];
  for (const [key, albums] of byLabel) {
    const grouped: LabelAlbumNode[] = [];
    const loose: TrackAnalysis[] = [];
    for (const [album, albumTracks] of albums) {
      if (albumTracks.length >= MIN_ALBUM_SIZE) {
        grouped.push({
          id: nodeId("album", key, album),
          album,
          tracks: sortAlbumTracks(albumTracks, edits),
        });
      } else {
        loose.push(...albumTracks);
      }
    }
    grouped.sort((a, b) => byName(a.album, b.album));
    loose.sort((a, b) => byName(titleOf(a, edits), titleOf(b, edits)));
    nodes.push({
      id: nodeId("label", key),
      key,
      name: key || NO_LABEL,
      albums: grouped,
      tracks: loose,
      all: [...grouped.flatMap((g) => g.tracks), ...loose],
    });
  }

  // The unknown bucket is pulled out so it stays last for every column and
  // direction (compareValues' "empty last" rule alone misses length/date).
  const unknown = nodes.filter((n) => n.key === NO_LABEL_KEY);
  const known = nodes.filter((n) => n.key !== NO_LABEL_KEY);

  if (isNumericSort(sortKey)) {
    known.sort((a, b) =>
      compareNumbers(labelNumber(a, edits, sortKey), labelNumber(b, edits, sortKey), dir),
    );
  } else {
    known.sort((a, b) => compareValues(a.key, b.key, dir));
  }

  return [...known, ...unknown];
}

/** Every track of the tree in render order (for the shift range selection). */
export function labelTrackList(nodes: LabelNode[]): TrackAnalysis[] {
  const out: TrackAnalysis[] = [];
  for (const n of nodes) out.push(...n.all);
  return out;
}

/** Ids of every label and album node (for expand/collapse-all). */
export function allLabelIds(nodes: LabelNode[]): string[] {
  const out: string[] = [];
  for (const n of nodes) {
    out.push(n.id);
    for (const a of n.albums) out.push(a.id);
  }
  return out;
}
