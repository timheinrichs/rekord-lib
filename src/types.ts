// Spiegelt die Rust-Modelle in src-tauri/src/models.rs

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

/** Vom Nutzer bestätigte Metadaten + Cover-Wahl für einen Track. */
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

export const FORMAT_LABELS: Record<TargetFormat, string> = {
  aiff: "AIFF (empfohlen)",
  wav: "WAV",
  flac: "FLAC",
  alac: "ALAC",
  mp3: "MP3 320k",
  aac: "AAC 320k",
};

/** Formate, die nur auf neueren Playern (CDJ-3000/NXS2) laufen. */
export const NEWER_PLAYERS_ONLY: TargetFormat[] = ["flac", "alac"];
