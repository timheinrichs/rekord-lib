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

/** Analysiert die übergebenen Dateipfade im Rust-Backend. */
export function analyzeFiles(paths: string[]): Promise<TrackAnalysis[]> {
  return invoke<TrackAnalysis[]>("analyze_files", { paths });
}

/** Startet einen Library-Scan (Hintergrund-Singleton). false = lief bereits. */
export function startScan(dir: string): Promise<boolean> {
  return invoke<boolean>("start_scan", { dir });
}

/** Aktueller Scan-Status (zum Andocken nach Reload). */
export function scanStatus(): Promise<ScanStatus> {
  return invoke<ScanStatus>("scan_status");
}

/** Bricht einen laufenden Scan ab. */
export function cancelScan(): Promise<void> {
  return invoke("cancel_scan");
}

/** Abonniert Fortschritts-Events des Library-Scans. */
export function onScanProgress(
  cb: (p: ScanProgress) => void,
): Promise<UnlistenFn> {
  return listen<ScanProgress>("scan://progress", (e) => cb(e.payload));
}

/** Abonniert das Abschluss-Event des Scans (liefert das Ergebnis). */
export function onScanDone(cb: (d: ScanDone) => void): Promise<UnlistenFn> {
  return listen<ScanDone>("scan://done", (e) => cb(e.payload));
}

/** Startet die Duplikatsuche (Hintergrund-Singleton). false = lief bereits. */
export function startDedupe(candidates: DupCandidate[]): Promise<boolean> {
  return invoke<boolean>("start_dedupe", { candidates });
}

/** Aktueller Dedupe-Status (running/Fortschritt/Ergebnis vorhanden). */
export function dedupeStatus(): Promise<DedupeStatus> {
  return invoke<DedupeStatus>("dedupe_status");
}

/** Liefert das zwischengespeicherte Dedupe-Ergebnis (oder null). */
export function dedupeResult(): Promise<DuplicateGroup[] | null> {
  return invoke<DuplicateGroup[] | null>("dedupe_result");
}

/** Bricht eine laufende Duplikatsuche ab. */
export function cancelDedupe(): Promise<void> {
  return invoke("cancel_dedupe");
}

/** Abonniert Fortschritts-Events der Duplikatsuche. */
export function onDedupeProgress(
  cb: (p: DedupeProgress) => void,
): Promise<UnlistenFn> {
  return listen<DedupeProgress>("dedupe://progress", (e) => cb(e.payload));
}

/** Abonniert das Abschluss-Event der Duplikatsuche (liefert das Ergebnis). */
export function onDedupeDone(cb: (d: DedupeDone) => void): Promise<UnlistenFn> {
  return listen<DedupeDone>("dedupe://done", (e) => cb(e.payload));
}

/** Verschiebt Dateien in den Papierkorb (umkehrbar). */
export function deleteFiles(paths: string[]): Promise<DeleteResult[]> {
  return invoke<DeleteResult[]>("delete_files", { paths });
}

/** Startet die Konvertierung. Fortschritt kommt über onConvertProgress. */
export function convertTracks(
  jobs: ConvertJob[],
  options: ConvertOptions,
): Promise<ConvertResult[]> {
  return invoke<ConvertResult[]>("convert_tracks", { jobs, options });
}

/** Abonniert Fortschritts-Events pro Datei. */
export function onConvertProgress(
  cb: (p: ConvertProgress) => void,
): Promise<UnlistenFn> {
  return listen<ConvertProgress>("convert://progress", (e) => cb(e.payload));
}

/** Holt Metadaten-Vorschläge (Tags, Dateiname, MusicBrainz) für eine Datei. */
export function suggestMetadata(path: string): Promise<MetadataSuggestions> {
  return invoke<MetadataSuggestions>("suggest_metadata", { path });
}

/** Liefert eine Cover-Vorschau als data:-URL für die gewählte Cover-Quelle. */
export function coverPreview(
  source: string,
  cover: CoverInput,
): Promise<string | null> {
  return invoke<string | null>("cover_preview", { source, cover });
}

/** Liefert ein kleines eingebettetes Cover-Thumbnail (data:-URL) für die Liste. */
export function coverThumbnail(path: string): Promise<string | null> {
  return invoke<string | null>("cover_thumbnail", { path });
}

/** Öffnet den Datei-Dialog zur Auswahl einer Bilddatei (Cover). */
export async function pickImageFile(): Promise<string | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Bild", extensions: ["jpg", "jpeg", "png", "webp"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/** Öffnet den Datei-Dialog zur Auswahl von Audiodateien. */
export async function pickAudioFiles(): Promise<string[]> {
  const selected = await open({
    multiple: true,
    directory: false,
    filters: [{ name: "Audio", extensions: AUDIO_EXTENSIONS }],
  });
  if (!selected) return [];
  return Array.isArray(selected) ? selected : [selected];
}

/** Öffnet den Ordner-Dialog für den Ausgabeordner. */
export async function pickOutputDir(): Promise<string | null> {
  const selected = await open({ multiple: false, directory: true });
  return typeof selected === "string" ? selected : null;
}

// --- Bandcamp ---

/** Öffnet das Bandcamp-Login-Fenster. */
export function bandcampLogin(): Promise<void> {
  return invoke("bandcamp_login");
}

/** Übernimmt die Session nach dem Login und liefert das Konto. */
export function bandcampConnect(): Promise<BandcampAccount> {
  return invoke<BandcampAccount>("bandcamp_connect");
}

/** Liefert das aktuell verbundene Konto (oder null, falls nicht verbunden). */
export function bandcampStatus(): Promise<BandcampAccount | null> {
  return invoke<BandcampAccount | null>("bandcamp_status");
}

/** Meldet von Bandcamp ab. */
export function bandcampDisconnect(): Promise<void> {
  return invoke("bandcamp_disconnect");
}

/** Liefert die gekaufte Sammlung. */
export function bandcampCollection(): Promise<BandcampItem[]> {
  return invoke<BandcampItem[]>("bandcamp_collection");
}

/** Lädt ein gekauftes Item verlustfrei herunter. */
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

/** Abonniert Fortschritts-Events der Bandcamp-Downloads. */
export function onBandcampProgress(
  cb: (p: BandcampProgress) => void,
): Promise<UnlistenFn> {
  return listen<BandcampProgress>("bandcamp://progress", (e) => cb(e.payload));
}
