import type { TrackAnalysis, TrackEdit } from "../types";

/** Sind die Pflichtfelder (Titel/Artist/Album + Cover) gesetzt? */
export function editComplete(edit: TrackEdit): boolean {
  const m = edit.metadata;
  return (
    !!m.title?.trim() && !!m.artist?.trim() && !!m.album?.trim() && m.has_cover
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
      className: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    });
  } else {
    badges.push({
      label: "Konvertieren",
      className: "bg-amber-500/15 text-amber-300 ring-amber-500/30",
      title: t.compat.issues.map((i) => i.message).join("\n"),
    });
  }
  const warnings = t.compat.issues.filter((i) => i.severity === "warning");
  if (t.compat.compatible && warnings.length) {
    badges.push({
      label: "Hinweis",
      className: "bg-sky-500/15 text-sky-300 ring-sky-500/30",
      title: warnings.map((i) => i.message).join("\n"),
    });
  }
  const complete = edit ? editComplete(edit) : !t.metadata_incomplete;
  if (edit && complete) {
    badges.push({
      label: "Metadaten ✓",
      className: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
    });
  } else if (!complete) {
    badges.push({
      label: "Metadaten unvollständig",
      className: "bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/30",
    });
  }
  if (fromBandcamp) {
    badges.push({
      label: "Bandcamp",
      className: "bg-teal-500/15 text-teal-300 ring-teal-500/30",
    });
  }
  return badges;
}
