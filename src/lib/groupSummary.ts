import type { TrackAnalysis } from "../types";
import { albumArtistOf, albumOf, type Edits } from "./grouping";
import { formatLabel } from "./format";

/** Aggregated column values of a group header row (album, label, folder). */
export interface GroupSummary {
  count: number;
  /** Summed playing time in seconds. */
  totalLength: number;
  /** Newest download date, or null when no track has one. */
  newestDate: number | null;
  /** Shared format label, else "Mixed" ("–" for an empty group). */
  format: string;
  /** Shared album artist, else "Various" ("" when the group has none). */
  albumArtist: string;
  /** Distinct, non-empty album names in encounter order. */
  albums: string[];
  needConvert: number;
  needIncomplete: number;
}

/**
 * Aggregates the column values shown on a group header row. Edit-aware via
 * `albumArtistOf` / `albumOf`; `isIncomplete` is injected because the view's
 * predicate already accounts for pending edits. Pure.
 */
export function summarizeGroup(
  tracks: TrackAnalysis[],
  edits: Edits,
  isIncomplete: (t: TrackAnalysis) => boolean,
): GroupSummary {
  const formats = new Set<string>();
  const artists = new Set<string>();
  const albums: string[] = [];
  let totalLength = 0;
  let newestDate: number | null = null;
  let needConvert = 0;
  let needIncomplete = 0;

  for (const t of tracks) {
    formats.add(
      formatLabel(t.audio.codec, t.audio.container, t.audio.bits_per_sample),
    );
    const artist = albumArtistOf(t, edits);
    if (artist) artists.add(artist);
    const album = albumOf(t, edits).trim();
    if (album && !albums.includes(album)) albums.push(album);
    totalLength += t.audio.duration_secs;
    if (t.download_date != null)
      newestDate = Math.max(newestDate ?? t.download_date, t.download_date);
    if (!t.compat.compatible) needConvert++;
    if (isIncomplete(t)) needIncomplete++;
  }

  return {
    count: tracks.length,
    totalLength,
    newestDate,
    format: formats.size === 1 ? [...formats][0] : formats.size ? "Mixed" : "–",
    albumArtist: artists.size === 1 ? [...artists][0] : artists.size ? "Various" : "",
    albums,
    needConvert,
    needIncomplete,
  };
}

/** Album column text of a group header: the album name, or "N albums". */
export function albumsLabel(albums: string[]): string {
  if (albums.length === 1) return albums[0];
  if (!albums.length) return "–";
  return `${albums.length} albums`;
}
