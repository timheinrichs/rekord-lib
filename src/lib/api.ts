import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  BandcampAccount,
  BandcampItem,
  ConvertJob,
  ConvertOptions,
  ConvertProgress,
  ConvertResult,
  CoverInput,
  MetadataSuggestions,
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
