// Mirrors the Rust models in src-tauri/src/models.rs

export type TargetFormat = "aiff" | "wav" | "flac" | "alac" | "mp3" | "aac";

export type Severity = "error" | "warning";

export interface AudioInfo {
  container: string;
  codec: string;
  sample_rate: number;
  bits_per_sample: number;
  channels: number;
  duration_secs: number;
  lossless: boolean;
}

export interface TrackMetadata {
  title: string | null;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  genre: string | null;
  year: string | null;
  track_number: number | null;
  catalog_number: string | null;
  label: string | null;
  country: string | null;
  /** Tempo in beats per minute, fractional (tag value or detected in the scan). */
  bpm: number | null;
  has_cover: boolean;
}

/**
 * A track's waveform overview: `peak` and `rms` per bin, 0..1, normalised so the
 * loudest bin's peak is 1. Mirrors `audio::waveform::Waveform`.
 */
export interface Waveform {
  peak: number[];
  rms: number[];
}

export interface CompatIssue {
  code: string;
  message: string;
  severity: Severity;
}

export interface CompatReport {
  compatible: boolean;
  issues: CompatIssue[];
}

export interface TrackAnalysis {
  id: string;
  path: string;
  file_name: string;
  audio: AudioInfo;
  metadata: TrackMetadata;
  compat: CompatReport;
  metadata_incomplete: boolean;
  /** File creation time (Unix millis), used as the "downloaded" date. */
  download_date: number | null;
  /**
   * How much the detector trusted the tempo it found (0..1), or null where the
   * BPM came from the file's tag. Below `UNCERTAIN_BPM_CONFIDENCE` the backend
   * deliberately did not write it into the file.
   */
  bpm_confidence: number | null;
  /**
   * Detected musical key as its name ("Am"), its Camelot position ("8A"), and
   * how clearly it won.
   *
   * Never written into the file. The best detector measured agrees with
   * Rekordbox about a third of the time (`docs/DSP_BENCHMARK.md`), and a wrong
   * TKEY is read by every other program and outlives the guess that made it —
   * so this lives in the database, where a better detector replaces it.
   */
  key: string | null;
  key_camelot: string | null;
  key_confidence: number | null;
  /**
   * Where the first beat sits, in seconds from the start of the track, and how
   * clearly its phase won. Together with `bpm` this is the whole beat grid —
   * our detector produces one tempo per track, so a grid is a period and a
   * phase. Written into the Rekordbox export as a `TEMPO` marker.
   */
  beat_offset_secs: number | null;
  beat_confidence: number | null;
  /**
   * This version's detector has already listened and found no tempo — an
   * interlude, a drone, an air check. Distinct from `bpm === null`, which also
   * covers "nobody has looked yet", and that distinction is what keeps the
   * backlog from re-analysing those files on every start.
   */
  bpm_absent: boolean;
  /**
   * The same, for the phase: this version listened for a beat grid and found
   * none it may keep — no clear pulse, or a phase that disagrees with the tempo
   * already on the row. Without it a track with a tempo and no grid looks like
   * one nobody has analysed, and goes back into the backlog at every start.
   */
  grid_absent: boolean;
}

export interface ConvertOptions {
  format: TargetFormat;
  bit_depth: number;
  output_dir: string | null;
  sanitize_filenames: boolean;
  replace_source: boolean;
}

export type CoverInput =
  | { kind: "keep" }
  | { kind: "none" }
  | { kind: "musicbrainz"; release_id: string }
  | { kind: "file"; path: string }
  /** Raw image bytes. Only produced by the undo history, never by the editor. */
  | { kind: "data"; base64: string };

export interface ConvertJob {
  id: string;
  path: string;
  metadata: TrackMetadata | null;
  cover: CoverInput | null;
}

export interface MbCandidate {
  title: string | null;
  artist: string | null;
  album: string | null;
  year: string | null;
  genre: string | null;
  track_number: number | null;
  release_id: string | null;
  score: number;
}

export interface FieldSuggestions {
  genres: string[];
  years: string[];
  labels: string[];
  countries: string[];
}

export interface MetadataSuggestions {
  id: string;
  current: TrackMetadata;
  filename_guess: TrackMetadata;
  candidates: MbCandidate[];
  field_suggestions: FieldSuggestions;
}

/** Outcome of re-pointing the library folder at a new location. */
export interface RelocateResult {
  /** Rows rewritten to the new root. */
  moved: number;
  /** Rows left at the old path because the file is not under the new root. */
  skipped: number;
}

/** User-confirmed metadata + cover choice for a track. */
export interface TrackEdit {
  metadata: TrackMetadata;
  cover: CoverInput;
}

export interface BandcampAccount {
  username: string;
  fan_id: number;
}

export interface BandcampItem {
  key: string;
  title: string;
  band_name: string;
  item_type: string;
  art_url: string | null;
  download_page_url: string | null;
}

export interface ConvertResult {
  id: string;
  source_path: string;
  output_path: string | null;
  success: boolean;
  error: string | null;
}

export interface ConvertProgress {
  id: string;
  percent: number;
  stage: string;
}

/** Scan stage labels, mirroring the constants in src-tauri/src/commands.rs. */
export const STAGE_ANALYZING = "Analyzing";
export const STAGE_BPM = "Detecting BPM";
/** Only keys left to find — a library another program has already tagged. */
export const STAGE_KEY = "Detecting key";
/** The usual case on a fresh library: one decode, both answers. */
export const STAGE_BPM_KEY = "Detecting BPM & key";
export const STAGE_DUPLICATES = "Finding duplicates";

export interface ScanProgress {
  generation: number;
  done: number;
  total: number;
  running: boolean;
  /** Held between units of work; the counters say where it will continue. */
  paused: boolean;
  /** Which pass the counters refer to (see the STAGE_* constants). */
  stage: string;
}

export interface ScanStatus {
  running: boolean;
  paused: boolean;
  generation: number;
  done: number;
  total: number;
  stage: string;
}

export interface ScanDone {
  generation: number;
  cancelled: boolean;
  /** False when only a subset of paths was processed — do not drop the rest. */
  full: boolean;
  tracks: TrackAnalysis[];
}

/** How much attention an event deserves. */
export type EventLevel = "info" | "warn" | "error";

/** One line in the event log (see lib/events). */
export interface AppEvent {
  id: number;
  created_ms: number;
  level: EventLevel;
  /** Which part of the app produced it — a label, not something to branch on. */
  source: string;
  message: string;
  detail: string | null;
}

/** The log plus how far the user has read, fetched together so they agree. */
export interface EventLog {
  events: AppEvent[];
  seen_id: number;
}

/**
 * A file the analysis could not use. Streamed as it happens rather than
 * returned with the result, because the same reporting covers the incremental
 * sync and a tag write's re-read, neither of which ends in a `ScanDone`.
 */
export interface SkippedFile {
  path: string;
  file_name: string;
  reason: string;
}

/** A batch of tracks streamed while the scan runs. */
/**
 * A playlist without its contents — the list the grouping mode draws its heads
 * from. The tracks come from `playlist_contents`, which answers for all of them
 * at once.
 */
export interface Playlist {
  id: number;
  name: string;
  created_ms: number;
  updated_ms: number;
  /** Counted by the query, so it cannot drift from the membership rows. */
  track_count: number;
}

export interface ScanTracks {
  generation: number;
  tracks: TrackAnalysis[];
  /**
   * Of `tracks`, the paths that were really re-probed. The batch also carries
   * rows the scan reused from the database unchanged, and a per-file cache has
   * to tell them apart: a reused row is the same file it was a moment ago.
   */
  fresh: string[];
}

/**
 * What one finished analysis has to say about one track. Only the fields it
 * produced are set: absent means *unchanged*, not "not detected" — the analysis
 * never clears a value it failed to find.
 */
export interface TrackPatch {
  path: string;
  bpm: number | null;
  bpm_confidence: number | null;
  key: string | null;
  key_camelot: string | null;
  key_confidence: number | null;
  /**
   * A waveform was stored for this path. A signal rather than a payload: the
   * waveform lives in its own table and is fetched by the row that draws it.
   */
  waveform: boolean;
}

/** One track's analysis result, the moment it is finished. */
export interface ScanPatch {
  generation: number;
  patch: TrackPatch;
}

export interface DedupeProgress {
  generation: number;
  done: number;
  total: number;
  stage: string;
  running: boolean;
}

export interface BandcampProgress {
  key: string;
  downloaded: number;
  total: number;
  stage: string;
}

export interface DedupeStatus {
  running: boolean;
  generation: number;
  done: number;
  total: number;
  stage: string;
  has_result: boolean;
}

export interface DedupeDone {
  generation: number;
  cancelled: boolean;
  groups: DuplicateGroup[];
}

/** Lightweight projection of a track as a candidate for duplicate detection. */
export interface DupCandidate {
  id: string;
  path: string;
  name: string;
  codec: string;
  container: string;
  sample_rate: number;
  bits_per_sample: number;
  lossless: boolean;
  duration_secs: number;
  compatible: boolean;
  title?: string | null;
  artist?: string | null;
  album_artist?: string | null;
  album?: string | null;
  track_number?: number | null;
}

export interface DuplicateFile {
  id: string;
  path: string;
  file_name: string;
  codec: string;
  container: string;
  sample_rate: number;
  bits_per_sample: number;
  lossless: boolean;
  duration_secs: number;
  compatible: boolean;
  size_bytes: number;
  title?: string | null;
  artist?: string | null;
  album?: string | null;
}

export interface DuplicateGroup {
  id: string;
  files: DuplicateFile[];
  /** Suggestion for which file to keep (highest quality). */
  keep_id: string;
}

export interface DeleteResult {
  path: string;
  success: boolean;
  error: string | null;
}

export const FORMAT_LABELS: Record<TargetFormat, string> = {
  aiff: "AIFF (recommended)",
  wav: "WAV",
  flac: "FLAC",
  alac: "ALAC",
  mp3: "MP3 320k",
  aac: "AAC 320k",
};

/** Formats that only work on newer players (CDJ-3000/NXS2). */
export const NEWER_PLAYERS_ONLY: TargetFormat[] = ["flac", "alac"];
