import type { BandcampItem, TrackAnalysis } from "../types";

/** Normalisiert einen Titel/Namen für den unscharfen Abgleich. */
function normalize(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // Diakritika entfernen
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Passt ein lokaler Track zum Bandcamp-Eintrag (Album/Track + Artist)? */
function matches(track: TrackAnalysis, item: BandcampItem): boolean {
  const itemTitle = normalize(item.title);
  const band = normalize(item.band_name);
  if (!itemTitle) return false;

  const album = normalize(track.metadata.album);
  const title = normalize(track.metadata.title);
  const artist = normalize(track.metadata.album_artist ?? track.metadata.artist);

  // Album-Kauf: Album-Tag == Item-Titel. Einzeltrack: Track-Titel == Item-Titel.
  const titleHit = album === itemTitle || title === itemTitle;
  if (!titleHit) return false;

  // Artist locker prüfen (leerer Band-Name gilt als Treffer).
  if (!band || !artist) return true;
  return artist === band || artist.includes(band) || band.includes(artist);
}

export interface SyncResult {
  /** Track-ID → Bandcamp-Key für lokal vorhandene Käufe. */
  originById: Record<string, string>;
  /** Käufe, die (noch) nicht in der Library liegen. */
  missing: BandcampItem[];
}

/** Gleicht die gescannte Library mit der Bandcamp-Sammlung ab. */
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
