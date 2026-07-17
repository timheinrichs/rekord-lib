import type { TrackAnalysis, TrackEdit } from "../types";

/**
 * Sind alle für Rekordbox relevanten Textfelder gesetzt?
 * (Titel, Artist, Album, Album-Artist, Genre, Jahr)
 */
export function editComplete(edit: TrackEdit): boolean {
  const m = edit.metadata;
  return (
    !!m.title?.trim() &&
    !!m.artist?.trim() &&
    !!m.album?.trim() &&
    !!m.album_artist?.trim() &&
    !!m.genre?.trim() &&
    !!m.year?.trim()
  );
}

export function formatDuration(secs: number): string {
  if (!secs || secs < 0) return "–";
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function formatSampleRate(hz: number): string {
  if (!hz) return "–";
  return `${(hz / 1000).toFixed(1)} kHz`;
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

/** Erzeugt die Status-Badges für einen Track (Kompatibilität, Metadaten, Herkunft). */
export function trackBadges(
  t: TrackAnalysis,
  edit?: TrackEdit,
  fromBandcamp?: boolean,
): Badge[] {
  const badges: Badge[] = [];
  if (t.compat.compatible) {
    badges.push({
      label: "Kompatibel",
      className: "bg-success-500/15 text-success-500 ring-success-500/30",
    });
  } else {
    badges.push({
      label: "Konvertieren",
      className: "bg-warning-500/15 text-warning-500 ring-warning-500/30",
      title: t.compat.issues.map((i) => i.message).join("\n"),
    });
  }
  const warnings = t.compat.issues.filter((i) => i.severity === "warning");
  if (t.compat.compatible && warnings.length) {
    badges.push({
      label: "Hinweis",
      className: "bg-accent-500/15 text-accent-300 ring-accent-500/30",
      title: warnings.map((i) => i.message).join("\n"),
    });
  }
  const complete = edit ? editComplete(edit) : !t.metadata_incomplete;
  if (edit && complete) {
    badges.push({
      label: "Metadaten ✓",
      className: "bg-success-500/15 text-success-500 ring-success-500/30",
    });
  } else if (!complete) {
    badges.push({
      label: "Metadaten unvollständig",
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
