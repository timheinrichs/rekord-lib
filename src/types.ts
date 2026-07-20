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
  has_cover: boolean;
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
  | { kind: "file"; path: string };

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

export interface MetadataSuggestions {
  id: string;
  current: TrackMetadata;
  filename_guess: TrackMetadata;
  candidates: MbCandidate[];
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

export interface ScanProgress {
  generation: number;
  done: number;
  total: number;
  running: boolean;
}

export interface ScanStatus {
  running: boolean;
  generation: number;
  done: number;
  total: number;
}

export interface ScanDone {
  generation: number;
  cancelled: boolean;
  tracks: TrackAnalysis[];
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
