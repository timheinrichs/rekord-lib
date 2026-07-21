use serde::{Deserialize, Serialize};

/// Target format of the conversion. Default is AIFF (universally CDJ-compatible).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TargetFormat {
    Aiff,
    Wav,
    Flac,
    Alac,
    Mp3,
    Aac,
}

impl Default for TargetFormat {
    fn default() -> Self {
        TargetFormat::Aiff
    }
}

impl TargetFormat {
    /// File extension of the target container.
    pub fn extension(&self) -> &'static str {
        match self {
            TargetFormat::Aiff => "aiff",
            TargetFormat::Wav => "wav",
            TargetFormat::Flac => "flac",
            TargetFormat::Alac => "m4a",
            TargetFormat::Mp3 => "mp3",
            TargetFormat::Aac => "m4a",
        }
    }

    /// PCM-based formats accept a selectable bit depth.
    #[allow(dead_code)] // used in phase 2 (metadata/cover)
    pub fn is_pcm(&self) -> bool {
        matches!(self, TargetFormat::Aiff | TargetFormat::Wav)
    }

    /// Does this format only run on newer players (CDJ-3000/NXS2)?
    #[allow(dead_code)] // used in phase 2
    pub fn newer_players_only(&self) -> bool {
        matches!(self, TargetFormat::Flac | TargetFormat::Alac)
    }
}

/// Technical audio properties from ffprobe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioInfo {
    pub container: String,
    pub codec: String,
    pub sample_rate: u32,
    /// Bit depth for PCM; 0 if unknown/lossy.
    pub bits_per_sample: u32,
    pub channels: u32,
    pub duration_secs: f64,
    pub lossless: bool,
}

/// Metadata read from the file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrackMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub track_number: Option<u32>,
    /// Release catalog number (e.g. "STROOM-007").
    #[serde(default)]
    pub catalog_number: Option<String>,
    /// Record label / publisher.
    #[serde(default)]
    pub label: Option<String>,
    /// Release country (e.g. "Germany"). Stored as a RELEASECOUNTRY tag.
    #[serde(default)]
    pub country: Option<String>,
    pub has_cover: bool,
}

impl TrackMetadata {
    /// Are all text fields relevant for Rekordbox set?
    /// (title, artist, album, album artist, year — genre is optional)
    pub fn is_complete(&self) -> bool {
        fn filled(v: &Option<String>) -> bool {
            v.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false)
        }
        filled(&self.title)
            && filled(&self.artist)
            && filled(&self.album)
            && filled(&self.album_artist)
            && filled(&self.year)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

/// A single compatibility issue with the source file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatIssue {
    pub code: String,
    pub message: String,
    pub severity: Severity,
}

/// Compatibility report: does the file already run on all CDJ/XDJ?
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatReport {
    /// true = runs on all players without conversion.
    pub compatible: bool,
    pub issues: Vec<CompatIssue>,
}

/// Overall result of analyzing a file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackAnalysis {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub audio: AudioInfo,
    pub metadata: TrackMetadata,
    pub compat: CompatReport,
    /// true if required metadata is missing and suggestions would be useful.
    pub metadata_incomplete: bool,
    /// File creation time (Unix millis) — used as the "downloaded/added" date.
    pub download_date: Option<i64>,
}

/// Options for a conversion run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertOptions {
    pub format: TargetFormat,
    /// 16 or 24 (only relevant for PCM/FLAC/ALAC).
    #[serde(default = "default_bit_depth")]
    pub bit_depth: u32,
    /// Target folder; if empty, the output is written next to the source file.
    #[serde(default)]
    pub output_dir: Option<String>,
    /// Sanitize special characters in the file name.
    #[serde(default)]
    pub sanitize_filenames: bool,
    /// Delete the source file after a successful conversion when the output
    /// path differs (e.g. format change). Only for library conversions -
    /// not for imported (external) files.
    #[serde(default)]
    pub replace_source: bool,
}

fn default_bit_depth() -> u32 {
    16
}

/// Source of the cover to embed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CoverInput {
    /// Keep the existing cover of the source file.
    Keep,
    /// Do not embed a cover.
    None,
    /// Cover from the Cover Art Archive via a MusicBrainz release ID.
    Musicbrainz { release_id: String },
    /// Cover from a local image file.
    File { path: String },
}

impl Default for CoverInput {
    fn default() -> Self {
        CoverInput::Keep
    }
}

/// A single conversion job (may contain confirmed metadata).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertJob {
    pub id: String,
    pub path: String,
    /// Metadata confirmed by the user (phase 2); None = keep existing.
    #[serde(default)]
    pub metadata: Option<TrackMetadata>,
    /// Cover source; None is treated like `Keep`.
    #[serde(default)]
    pub cover: Option<CoverInput>,
}

/// A candidate from the MusicBrainz search.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MbCandidate {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
    pub track_number: Option<u32>,
    /// MusicBrainz release ID for the cover fetch.
    pub release_id: Option<String>,
    /// MusicBrainz score 0..100.
    pub score: u32,
}

/// Per-field suggestion lists (aggregated from Discogs + MusicBrainz).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct FieldSuggestions {
    pub genres: Vec<String>,
    pub years: Vec<String>,
    pub labels: Vec<String>,
    pub countries: Vec<String>,
}

/// Suggestions for a file's metadata for manual confirmation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataSuggestions {
    pub id: String,
    /// Tags currently present in the file.
    pub current: TrackMetadata,
    /// Guess derived from the file name/folder.
    pub filename_guess: TrackMetadata,
    /// Matches from the MusicBrainz database (may be empty).
    pub candidates: Vec<MbCandidate>,
    /// Clickable per-field suggestions (Discogs + MusicBrainz).
    pub field_suggestions: FieldSuggestions,
}

/// Result per converted file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertResult {
    pub id: String,
    pub source_path: String,
    pub output_path: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

/// Lean projection of a track as a candidate for the duplicate search.
#[derive(Debug, Clone, Deserialize)]
pub struct DupCandidate {
    pub id: String,
    pub path: String,
    /// Display name (title or file name) for the name similarity check.
    pub name: String,
    pub codec: String,
    pub container: String,
    pub sample_rate: u32,
    pub bits_per_sample: u32,
    pub lossless: bool,
    pub duration_secs: f64,
    pub compatible: bool,
    // Structured metadata for the metadata-based match tier (may be absent).
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub artist: Option<String>,
    #[serde(default)]
    pub album_artist: Option<String>,
    #[serde(default)]
    pub album: Option<String>,
}

/// A file within a duplicate group, including quality/size info.
#[derive(Debug, Clone, Serialize)]
pub struct DuplicateFile {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub codec: String,
    pub container: String,
    pub sample_rate: u32,
    pub bits_per_sample: u32,
    pub lossless: bool,
    pub duration_secs: f64,
    pub compatible: bool,
    pub size_bytes: u64,
    // Metadata for display + album clustering in the UI.
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
}

/// A group of detected duplicates (the same track across multiple files).
#[derive(Debug, Clone, Serialize)]
pub struct DuplicateGroup {
    /// Stable group ID (the smallest path in the group).
    pub id: String,
    pub files: Vec<DuplicateFile>,
    /// Suggestion for which file to keep (highest quality).
    pub keep_id: String,
}

/// Result of a delete operation per file.
#[derive(Debug, Clone, Serialize)]
pub struct DeleteResult {
    pub path: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Connected Bandcamp account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BandcampAccount {
    pub username: String,
    pub fan_id: i64,
}

/// An entry from the Bandcamp collection (purchased album/track).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BandcampItem {
    /// Unique key (sale_item_type + sale_item_id), e.g. "p12345".
    pub key: String,
    pub title: String,
    pub band_name: String,
    /// "album" or "track".
    pub item_type: String,
    /// Thumbnail URL (bcbits) or None.
    pub art_url: Option<String>,
    /// Download page (from redownload_urls); None if not (yet) downloadable.
    pub download_page_url: Option<String>,
}

/// Result of a Bandcamp download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BandcampDownloadResult {
    pub key: String,
    /// Downloaded (and possibly extracted) audio files.
    pub files: Vec<String>,
    pub success: bool,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_metadata() -> TrackMetadata {
        TrackMetadata {
            title: Some("Title".into()),
            artist: Some("Artist".into()),
            album: Some("Album".into()),
            album_artist: Some("Album Artist".into()),
            genre: Some("Techno".into()),
            year: Some("2024".into()),
            track_number: Some(1),
            catalog_number: None,
            label: None,
            country: None,
            has_cover: true,
        }
    }

    #[test]
    fn is_complete_true_when_all_text_fields_set() {
        assert!(full_metadata().is_complete());
    }

    #[test]
    fn is_complete_ignores_optional_catalog_label_and_genre() {
        // catalog_number, label and genre are intentionally optional.
        let mut md = full_metadata();
        md.genre = None;
        assert!(md.catalog_number.is_none() && md.label.is_none());
        assert!(md.is_complete());
    }

    #[test]
    fn is_complete_false_when_a_field_missing_or_blank() {
        let mut md = full_metadata();
        md.album = None;
        assert!(!md.is_complete());

        let mut md = full_metadata();
        md.year = Some("   ".into());
        assert!(!md.is_complete());
    }

    #[test]
    fn is_complete_false_for_default() {
        assert!(!TrackMetadata::default().is_complete());
    }

    #[test]
    fn target_format_extension_maps_containers() {
        assert_eq!(TargetFormat::Aiff.extension(), "aiff");
        assert_eq!(TargetFormat::Wav.extension(), "wav");
        assert_eq!(TargetFormat::Flac.extension(), "flac");
        assert_eq!(TargetFormat::Alac.extension(), "m4a");
        assert_eq!(TargetFormat::Mp3.extension(), "mp3");
        assert_eq!(TargetFormat::Aac.extension(), "m4a");
    }

    #[test]
    fn target_format_pcm_and_player_flags() {
        assert!(TargetFormat::Aiff.is_pcm() && TargetFormat::Wav.is_pcm());
        assert!(!TargetFormat::Flac.is_pcm() && !TargetFormat::Mp3.is_pcm());
        assert!(TargetFormat::Flac.newer_players_only());
        assert!(TargetFormat::Alac.newer_players_only());
        assert!(!TargetFormat::Aiff.newer_players_only());
        assert!(!TargetFormat::Mp3.newer_players_only());
    }

    #[test]
    fn target_format_default_is_aiff() {
        assert_eq!(TargetFormat::default(), TargetFormat::Aiff);
    }
}
