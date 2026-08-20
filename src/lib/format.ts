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

/**
 * Confidence below which a detected tempo was **not** written into the file.
 * Mirrors `MIN_WRITE_CONFIDENCE` in `src-tauri/src/commands.rs` (measured there,
 * not chosen), and the marker means exactly that: the number on screen is not in
 * your file. Roughly 1 % of a real collection lands here, so it stays a rare
 * mark rather than a wall of colour.
 */
export const UNCERTAIN_BPM_CONFIDENCE = 0.3;

/**
 * A tempo for display: whole beats, "128".
 *
 * The decimals are kept in the file and in the library — nearly half of a real
 * collection's tempos are fractional — but showing them turns every column into
 * "127.61" where "128" is what a DJ reads. Other DJ software displays it the
 * same way.
 *
 * This is display only, and that distinction carries weight in the metadata
 * editor: the field there is editable, so `toMetadata` keeps the original value
 * whenever the text was not touched. Otherwise editing an album's genre would
 * round every tempo in it.
 */
export function formatBpm(bpm: number | null | undefined): string {
  if (bpm == null || !Number.isFinite(bpm)) return "–";
  return String(Math.round(bpm));
}

/**
 * A tempo the user typed, as a number. Accepts a comma as the decimal
 * separator, because that is what a German keyboard produces and what taggers
 * write ("127,6"); `parseFloat` alone would read that as 127.
 *
 * Returns null for anything that is not a usable tempo, which is how the editor
 * clears the field.
 */
export function parseBpmInput(raw: string): number | null {
  const parsed = parseFloat(raw.trim().replace(",", "."));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * A detected key for display: `"Am · 8A"`, or a dash where there is none.
 *
 * Both spellings, because they answer different questions — the name says what
 * the track is, the Camelot number says what it mixes with — and a DJ reading a
 * list wants the second one.
 */
export function formatKey(
  key: string | null | undefined,
  camelot: string | null | undefined,
): string {
  if (!key) return "–";
  return camelot ? `${key} · ${camelot}` : key;
}

/**
 * How much to trust a detected key, as a short label.
 *
 * Shown as a percentage rather than hidden behind a threshold because, unlike
 * the tempo's, this value is *informative*: measured against 2180 Rekordbox
 * keys, agreement climbs from 32 % in the lowest confidence band to 71 % in the
 * highest (`docs/DSP_BENCHMARK.md`). There is no threshold that is both accurate
 * and covers much of a collection, so the number itself is the honest answer.
 */
export function keyConfidenceLabel(confidence: number | null | undefined): string | null {
  if (confidence == null || !Number.isFinite(confidence)) return null;
  return `${Math.round(confidence * 100)}% sure`;
}

/** Was this tempo detected without much conviction? */
export function bpmIsUncertain(confidence: number | null | undefined): boolean {
  return confidence != null && confidence < UNCERTAIN_BPM_CONFIDENCE;
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
