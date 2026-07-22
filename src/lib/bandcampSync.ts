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

/** Parent folder name of a POSIX-style path (matches the backend paths). */
function parentFolderName(path: string): string {
  const parts = path.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : "";
}

/** Does a local track match the Bandcamp entry (album/track + artist)? */
function matches(track: TrackAnalysis, item: BandcampItem): boolean {
  const itemTitle = normalize(item.title);
  const band = normalize(item.band_name);
  if (!itemTitle) return false;

  // Downloads are named after the purchase: an album ZIP extracts into a folder
  // "<title>/", a single track is saved as "<title>.<ext>". These names come
  // straight from the purchase and don't depend on tags, so an exact match is a
  // strong identity on its own — accept it without the artist check (which the
  // real tags often contradict, e.g. a "Various"-tagged compilation).
  const fileBase = normalize(track.file_name.replace(/\.[^./\\]+$/, ""));
  const folder = normalize(parentFolderName(track.path));
  if (fileBase === itemTitle || folder === itemTitle) return true;

  // Otherwise fall back to the tags, gated by a loose artist check to avoid
  // false hits on common album/track titles.
  const album = normalize(track.metadata.album);
  const title = normalize(track.metadata.title);
  const artist = normalize(track.metadata.album_artist ?? track.metadata.artist);
  if (album !== itemTitle && title !== itemTitle) return false;

  if (!band || !artist) return true;
  return artist === band || artist.includes(band) || band.includes(artist);
}

export interface SyncResult {
  /** Track ID → Bandcamp key for purchases present locally (for badges). */
  originById: Record<string, string>;
  /** Keys of purchases considered present (matched OR downloaded). */
  presentKeys: Set<string>;
  /** Purchases that are not (yet) in the library. */
  missing: BandcampItem[];
}

/**
 * Reconciles the scanned library with the Bandcamp collection.
 *
 * Presence is decided two ways, because fuzzy metadata matching alone is
 * unreliable (odd tag formatting, "Various Artists" albums, non-Latin titles):
 *  1. a local track matches the purchase (by tags, folder or file name), or
 *  2. the download ledger has recorded files for it.
 *
 * The ledger is authoritative for anything downloaded through the app: once a
 * download succeeded it is never re-offered as "missing", even before the new
 * files have been re-scanned into the library (which otherwise lagged and made
 * a just-downloaded item keep showing up). `originById` only maps tracks we can
 * actually see (for the origin badge); `presentKeys`/`missing` also honor the
 * ledger on their own.
 */
export function syncCollection(
  tracks: TrackAnalysis[],
  items: BandcampItem[],
  ledger: DownloadLedger = {},
): SyncResult {
  const originById: Record<string, string> = {};
  const presentKeys = new Set<string>();
  const missing: BandcampItem[] = [];
  const byPath = new Map(tracks.map((t) => [t.path, t]));

  for (const item of items) {
    // Map whatever local tracks we can recognize (drives the origin badge).
    const seen = new Set<TrackAnalysis>();
    for (const t of tracks) if (matches(t, item)) seen.add(t);
    for (const p of ledger[item.key] ?? []) {
      const t = byPath.get(p);
      if (t) seen.add(t);
    }
    for (const t of seen) originById[t.id] = item.key;

    // Present if a track matched it OR the app has downloaded it.
    const downloaded = (ledger[item.key]?.length ?? 0) > 0;
    if (seen.size > 0 || downloaded) {
      presentKeys.add(item.key);
    } else {
      missing.push(item);
    }
  }

  return { originById, presentKeys, missing };
}
