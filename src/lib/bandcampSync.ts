import type { BandcampItem, TrackAnalysis } from "../types";

/** Normalizes a title/name for fuzzy matching. */
function normalize(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // remove diacritics
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Does a local track match the Bandcamp entry (album/track + artist)? */
function matches(track: TrackAnalysis, item: BandcampItem): boolean {
  const itemTitle = normalize(item.title);
  const band = normalize(item.band_name);
  if (!itemTitle) return false;

  const album = normalize(track.metadata.album);
  const title = normalize(track.metadata.title);
  const artist = normalize(track.metadata.album_artist ?? track.metadata.artist);

  // Album purchase: album tag == item title. Single track: track title == item title.
  const titleHit = album === itemTitle || title === itemTitle;
  if (!titleHit) return false;

  // Loosely check the artist (an empty band name counts as a match).
  if (!band || !artist) return true;
  return artist === band || artist.includes(band) || band.includes(artist);
}

export interface SyncResult {
  /** Track ID → Bandcamp key for purchases present locally. */
  originById: Record<string, string>;
  /** Purchases that are not (yet) in the library. */
  missing: BandcampItem[];
}

/** Reconciles the scanned library with the Bandcamp collection. */
export function syncCollection(
  tracks: TrackAnalysis[],
  items: BandcampItem[],
): SyncResult {
  const originById: Record<string, string> = {};
  const missing: BandcampItem[] = [];

  for (const item of items) {
    const hits = tracks.filter((t) => matches(t, item));
    if (hits.length > 0) {
      for (const t of hits) originById[t.id] = item.key;
    } else {
      missing.push(item);
    }
  }

  return { originById, missing };
}
