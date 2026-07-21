import type { TrackAnalysis, TrackEdit } from "../types";

/**
 * Are all text fields relevant to Rekordbox set?
 * (title, artist, album, album artist, year — genre is optional)
 */
export function editComplete(edit: TrackEdit): boolean {
  const m = edit.metadata;
  return (
    !!m.title?.trim() &&
    !!m.artist?.trim() &&
    !!m.album?.trim() &&
    !!m.album_artist?.trim() &&
    !!m.year?.trim()
  );
}

export function formatDuration(secs: number): string {
  if (!secs || secs < 0) return "–";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Unix millis → "YYYY-MM-DD" (or "–"). */
export function formatDate(ms: number | null): string {
  if (!ms) return "–";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "–";
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function formatSampleRate(hz: number): string {
  if (!hz) return "–";
  return `${(hz / 1000).toFixed(1)} kHz`;
}

/**
 * Human-friendly format label from codec/container/bit depth.
 * Raw PCM codecs (e.g. "pcm_s16be") read as their container: "AIFF 16-bit".
 */
export function formatLabel(
  codec: string,
  container: string,
  bits: number,
): string {
  const co = codec.toLowerCase();
  const c = container.toLowerCase();
  const depth = bits > 0 ? ` ${bits}-bit` : "";
  if (co.startsWith("pcm")) {
    if (c.includes("aiff")) return `AIFF${depth}`;
    if (c.includes("wav")) return `WAV${depth}`;
    return `PCM${depth}`;
  }
  switch (co) {
    case "flac":
      return `FLAC${depth}`;
    case "alac":
      return `ALAC${depth}`;
    case "mp3":
      return "MP3";
    case "aac":
      return "AAC";
    default:
      return codec.toUpperCase();
  }
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes < 0) return "–";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let val = bytes / 1024;
  let i = 0;
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024;
    i++;
  }
  return `${val.toFixed(val < 10 ? 1 : 0)} ${units[i]}`;
}

export type Badge = { label: string; className: string; title?: string };

/** Builds the status badges for a track (compatibility, metadata, origin). */
export function trackBadges(
  t: TrackAnalysis,
  edit?: TrackEdit,
  fromBandcamp?: boolean,
): Badge[] {
  const badges: Badge[] = [];
  // Only flag files that need conversion; compatible files show no badge.
  if (!t.compat.compatible) {
    badges.push({
      label: "Convert",
      className: "bg-warning-500/15 text-warning-500 ring-warning-500/30",
      title: t.compat.issues.map((i) => i.message).join("\n"),
    });
  }
  const warnings = t.compat.issues.filter((i) => i.severity === "warning");
  if (t.compat.compatible && warnings.length) {
    badges.push({
      label: "Note",
      className: "bg-accent-500/15 text-accent-300 ring-accent-500/30",
      title: warnings.map((i) => i.message).join("\n"),
    });
  }
  const complete = edit ? editComplete(edit) : !t.metadata_incomplete;
  if (edit && complete) {
    badges.push({
      label: "Metadata ✓",
      className: "bg-success-500/15 text-success-500 ring-success-500/30",
    });
  } else if (!complete) {
    badges.push({
      label: "Metadata incomplete",
      className: "bg-warning-500/15 text-warning-500 ring-warning-500/30",
    });
  }
  if (fromBandcamp) {
    badges.push({
      label: "Bandcamp",
      className: "bg-accent-500/15 text-accent-300 ring-accent-500/30",
    });
  }
  return badges;
}
