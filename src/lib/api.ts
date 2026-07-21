import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BandcampAccount,
  BandcampItem,
  BandcampProgress,
  ConvertJob,
  ConvertOptions,
  ConvertProgress,
  ConvertResult,
  CoverInput,
  DedupeDone,
  DedupeProgress,
  DedupeStatus,
  DeleteResult,
  DupCandidate,
  DuplicateGroup,
  MetadataSuggestions,
  ScanDone,
  ScanProgress,
  ScanStatus,
  TrackAnalysis,
} from "../types";

export interface BandcampDownloadResult {
  key: string;
  files: string[];
  success: boolean;
  error: string | null;
}

const AUDIO_EXTENSIONS = [
  "aiff",
  "aif",
  "wav",
  "flac",
  "alac",
  "m4a",
  "mp3",
  "aac",
  "ogg",
  "opus",
  "wma",
];

/** Analyzes the given file paths in the Rust backend. */
export function analyzeFiles(paths: string[]): Promise<TrackAnalysis[]> {
  return invoke<TrackAnalysis[]>("analyze_files", { paths });
}

/** Starts a library scan (background singleton). false = already running. */
export function startScan(dir: string): Promise<boolean> {
  return invoke<boolean>("start_scan", { dir });
}

/** Current scan status (for reattaching after a reload). */
export function scanStatus(): Promise<ScanStatus> {
  return invoke<ScanStatus>("scan_status");
}

/** Cancels a running scan. */
export function cancelScan(): Promise<void> {
  return invoke("cancel_scan");
}

/** Subscribes to progress events of the library scan. */
export function onScanProgress(
  cb: (p: ScanProgress) => void,
): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan://progress", (e) => cb(e.payload));
}

/** Subscribes to the scan completion event (delivers the result). */
export function onScanDone(cb: (d: ScanDone) => void): Promise<UnlistenFn> {
  return listen<ScanDone>("scan://done", (e) => cb(e.payload));
}

/** Starts duplicate detection (background singleton). false = already running. */
export function startDedupe(candidates: DupCandidate[]): Promise<boolean> {
  return invoke<boolean>("start_dedupe", { candidates });
}

/** Current dedupe status (running/progress/result available). */
export function dedupeStatus(): Promise<DedupeStatus> {
  return invoke<DedupeStatus>("dedupe_status");
}

/** Returns the cached dedupe result (or null). */
export function dedupeResult(): Promise<DuplicateGroup[] | null> {
  return invoke<DuplicateGroup[] | null>("dedupe_result");
}

/** Cancels a running duplicate detection. */
export function cancelDedupe(): Promise<void> {
  return invoke("cancel_dedupe");
}

/** Subscribes to progress events of the duplicate detection. */
export function onDedupeProgress(
  cb: (p: DedupeProgress) => void,
): Promise<UnlistenFn> {
  return listen<DedupeProgress>("dedupe://progress", (e) => cb(e.payload));
}

/** Subscribes to the duplicate detection completion event (delivers the result). */
export function onDedupeDone(cb: (d: DedupeDone) => void): Promise<UnlistenFn> {
  return listen<DedupeDone>("dedupe://done", (e) => cb(e.payload));
}

/** Moves files to the trash (reversible). */
export function deleteFiles(paths: string[]): Promise<DeleteResult[]> {
  return invoke<DeleteResult[]>("delete_files", { paths });
}

/** Trashes directories that no longer contain any audio files (safety-checked). */
export function pruneEmptyDirs(dirs: string[]): Promise<DeleteResult[]> {
  return invoke<DeleteResult[]>("prune_empty_dirs", { dirs });
}

/** Starts the conversion. Progress arrives via onConvertProgress. */
export function convertTracks(
  jobs: ConvertJob[],
  options: ConvertOptions,
): Promise<ConvertResult[]> {
  return invoke<ConvertResult[]>("convert_tracks", { jobs, options });
}

/** Subscribes to per-file progress events. */
export function onConvertProgress(
  cb: (p: ConvertProgress) => void,
): Promise<UnlistenFn> {
  return listen<ConvertProgress>("convert://progress", (e) => cb(e.payload));
}

/** Fetches metadata suggestions (tags, filename, MusicBrainz) for a file. */
export function suggestMetadata(path: string): Promise<MetadataSuggestions> {
  return invoke<MetadataSuggestions>("suggest_metadata", { path });
}

/** Returns a cover preview as a data: URL for the chosen cover source. */
export function coverPreview(
  source: string,
  cover: CoverInput,
): Promise<string | null> {
  return invoke<string | null>("cover_preview", { source, cover });
}

/** Returns a small embedded cover thumbnail (data: URL) for the list. */
export function coverThumbnail(path: string): Promise<string | null> {
  return invoke<string | null>("cover_thumbnail", { path });
}

/** Opens the file dialog for selecting an image file (cover). */
export async function pickImageFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Image", extensions: ["jpg", "jpeg", "png", "webp"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Opens the file dialog for selecting audio files. */
export async function pickAudioFiles(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** Opens the folder dialog for the output directory. */
export async function pickOutputDir(): Promise<string | null> {
  const selected = await open({ multiple: false, directory: true });
  return typeof selected === "string" ? selected : null;
}

// --- Bandcamp ---

/** Opens the Bandcamp login window. */
export function bandcampLogin(): Promise<void> {
  return invoke("bandcamp_login");
}

/** Adopts the session after login and returns the account. */
export function bandcampConnect(): Promise<BandcampAccount> {
  return invoke<BandcampAccount>("bandcamp_connect");
}

/** Returns the currently connected account (or null if not connected). */
export function bandcampStatus(): Promise<BandcampAccount | null> {
  return invoke<BandcampAccount | null>("bandcamp_status");
}

/** Signs out of Bandcamp. */
export function bandcampDisconnect(): Promise<void> {
  return invoke("bandcamp_disconnect");
}

/** Returns the purchased collection. */
export function bandcampCollection(): Promise<BandcampItem[]> {
  return invoke<BandcampItem[]>("bandcamp_collection");
}

/** Downloads a purchased item losslessly. */
export function bandcampDownload(
  key: string,
  pageUrl: string,
  destDir: string,
): Promise<BandcampDownloadResult> {
  return invoke<BandcampDownloadResult>("bandcamp_download", {
    key,
    pageUrl,
    destDir,
  });
}

/** Subscribes to progress events of the Bandcamp downloads. */
export function onBandcampProgress(
  cb: (p: BandcampProgress) => void,
): Promise<UnlistenFn> {
  return listen<BandcampProgress>("bandcamp://progress", (e) => cb(e.payload));
}
