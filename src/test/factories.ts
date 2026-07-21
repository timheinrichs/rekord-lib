import type {
  AudioInfo,
  CompatReport,
  TrackAnalysis,
  TrackMetadata,
} from "../types";

/** A fully-populated metadata object; override fields per test. */
export function makeMetadata(over: Partial<TrackMetadata> = {}): TrackMetadata {
  return {
    title: "Title",
    artist: "Artist",
    album: "Album",
    album_artist: "Album Artist",
    genre: "Techno",
    year: "2024",
    track_number: 1,
    catalog_number: null,
    label: null,
    has_cover: true,
    ...over,
  };
}

export function makeAudio(over: Partial<AudioInfo> = {}): AudioInfo {
  return {
    container: "aiff",
    codec: "pcm_s16be",
    sample_rate: 44_100,
    bits_per_sample: 16,
    channels: 2,
    duration_secs: 180,
    lossless: true,
    ...over,
  };
}

export function makeCompat(over: Partial<CompatReport> = {}): CompatReport {
  return { compatible: true, issues: [], ...over };
}

/** A track. `id` defaults to `path`, matching the backend's convention. */
export function makeTrack(over: Partial<TrackAnalysis> = {}): TrackAnalysis {
  const path = over.path ?? "/music/Album/track.aiff";
  return {
    id: over.id ?? path,
    path,
    file_name: over.file_name ?? path.split("/").pop() ?? path,
    audio: over.audio ?? makeAudio(),
    metadata: over.metadata ?? makeMetadata(),
    compat: over.compat ?? makeCompat(),
    metadata_incomplete: over.metadata_incomplete ?? false,
  };
}
