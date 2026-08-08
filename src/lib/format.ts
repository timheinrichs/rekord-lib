import type { TrackAnalysis, TrackEdit } from "../types";

/**
 * Are all text fields relevant to Rekordbox set?
 * (title, artist, album, album artist — genre, year, catalog number, label
 * and country are optional)
 */
export function editComplete(edit: TrackEdit): boolean {
  const m = edit.metadata;
  return (
    !!m.title?.trim() &&
    !!m.artist?.trim() &&
    !!m.album?.trim() &&
    !!m.album_artist?.trim()
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

/** What a status marker on a track can mean. */
export type StatusKind =
  | "convert"
  | "note"
  | "complete"
  | "incomplete"
  | "bandcamp";

/** One status marker; `title` is the tooltip and the accessible name. */
export interface TrackStatus {
  kind: StatusKind;
  title: string;
}

/**
 * Status of a track (compatibility, metadata, origin) as data — how it looks
 * is up to the caller (see components/StatusIcons).
 */
export function trackStatus(
  t: TrackAnalysis,
  edit?: TrackEdit,
  fromBandcamp?: boolean,
): TrackStatus[] {
  const out: TrackStatus[] = [];
  // Only flag files that need conversion; compatible files show no marker.
  if (!t.compat.compatible) {
    const issues = t.compat.issues.map((i) => i.message).join("\n");
    out.push({
      kind: "convert",
      title: issues ? `Needs conversion\n${issues}` : "Needs conversion",
    });
  }
  const warnings = t.compat.issues.filter((i) => i.severity === "warning");
  if (t.compat.compatible && warnings.length) {
    out.push({
      kind: "note",
      title: warnings.map((i) => i.message).join("\n"),
    });
  }
  const complete = edit ? editComplete(edit) : !t.metadata_incomplete;
  if (edit && complete) {
    out.push({ kind: "complete", title: "Metadata complete" });
  } else if (!complete) {
    out.push({ kind: "incomplete", title: "Metadata incomplete" });
  }
  if (fromBandcamp) {
    out.push({ kind: "bandcamp", title: "From Bandcamp" });
  }
  return out;
}
