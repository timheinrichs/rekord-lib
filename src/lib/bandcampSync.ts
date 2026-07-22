import type { BandcampItem, TrackAnalysis } from "../types";
import type { DownloadLedger } from "./bandcampDownloads";

/** Normalizes a title/name for fuzzy matching. */
function normalize(s: string | null | undefined): string {
  return (s ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // remove diacritics
    // Keep letters/digits of ANY script (e.g. Cyrillic) — collapse the rest to
    // spaces. Stripping to a-z0-9 previously erased non-Latin titles entirely,
    // so they could never match and were re-downloaded on every sync.
    .replace(/[^\p{L}\p{N}]+/gu, " ")
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
  // Single-track downloads are saved as "<title>.<ext>" and frequently carry no
  // readable tags at all, so fall back to the file name (minus extension).
  const fileBase = normalize(track.file_name.replace(/\.[^./\\]+$/, ""));

  // Album purchase: album tag == item title. Single track: track title (or, when
  // untagged, the file name) == item title.
  const titleHit =
    album === itemTitle || title === itemTitle || fileBase === itemTitle;
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

/**
 * Reconciles the scanned library with the Bandcamp collection.
 *
 * Presence is decided two ways, which is important because fuzzy metadata
 * matching alone is unreliable (odd tag formatting, "Various Artists" albums,
 * non-Latin titles): an item counts as present if it either matches a local
 * track by metadata OR the download ledger recorded files for it that are still
 * in the library. The ledger is authoritative for anything downloaded through
 * the app, so a successful download is never re-offered as "missing".
 */
export function syncCollection(
  tracks: TrackAnalysis[],
  items: BandcampItem[],
  ledger: DownloadLedger = {},
): SyncResult {
  const originById: Record<string, string> = {};
  const missing: BandcampItem[] = [];
  const byPath = new Map(tracks.map((t) => [t.path, t]));

  for (const item of items) {
    const present = new Set<TrackAnalysis>();
    for (const t of tracks) if (matches(t, item)) present.add(t);
    // Ledger fallback: recorded files that still exist in the library.
    for (const p of ledger[item.key] ?? []) {
      const t = byPath.get(p);
      if (t) present.add(t);
    }
    if (present.size > 0) {
      for (const t of present) originById[t.id] = item.key;
    } else {
      missing.push(item);
    }
  }

  return { originById, missing };
}
