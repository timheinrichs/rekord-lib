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
    /// Tempo in beats per minute (ID3 `TBPM`, MP4 `tmpo`, Vorbis `BPM`).
    /// Either read from the tag or detected by [`crate::audio::bpm`].
    ///
    /// Fractional, because Rekordbox stores it that way and nearly half of a
    /// real collection's tempos are not integers. Older stored values were
    /// integers, which deserialise into this without help.
    #[serde(default)]
    pub bpm: Option<f64>,
    pub has_cover: bool,
}

impl TrackMetadata {
    /// Are all text fields relevant for Rekordbox set?
    /// (title, artist, album, album artist — genre, year, catalog number,
    /// label, country and BPM are optional)
    pub fn is_complete(&self) -> bool {
        fn filled(v: &Option<String>) -> bool {
            v.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false)
        }
        filled(&self.title)
            && filled(&self.artist)
            && filled(&self.album)
            && filled(&self.album_artist)
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
    /// How much the detector trusted its own tempo (0..1), or `None` where the
    /// BPM came from the file's tag rather than from analysis.
    ///
    /// Deliberately *not* in [`TrackMetadata`]: that mirrors what is written
    /// into files and travels through the write and undo paths, while this is
    /// analysis state about the last detection.
    #[serde(default)]
    pub bpm_confidence: Option<f32>,
    /// Detected musical key, as its name (`"Am"`, `"F#m"`, `"C"`).
    ///
    /// Also not in [`TrackMetadata`], and for a stronger reason than the
    /// confidence: the key is **never written into the file**. Measured against
    /// 2180 Rekordbox keys, the best detector available agrees about a third of
    /// the time (`docs/DSP_BENCHMARK.md`), and a wrong `TKEY` in someone's
    /// library is read by every other program and outlives the guess that
    /// produced it. It lives in the database, where a better detector simply
    /// replaces it.
    #[serde(default)]
    pub key: Option<String>,
    /// The same key as its Camelot position (`"8A"`). Derived on read from
    /// [`Self::key`] rather than stored — a pure function of it, like `compat`.
    #[serde(default)]
    pub key_camelot: Option<String>,
    /// How clearly the winning key beat the runner-up (0..1). The runner-up is
    /// usually the relative or the parallel, so a small margin means precisely
    /// "it could be that one instead".
    #[serde(default)]
    pub key_confidence: Option<f32>,
    /// This version's detector has already listened to this file and found no
    /// tempo — an interlude, a drone, an air check, something with no periodic
    /// pulse to find.
    ///
    /// The difference between "no tempo yet" and "no tempo, and we know why" is
    /// the whole point: without it the backlog re-analyses those files on every
    /// single start, forever, and they are exactly the files where the answer
    /// will not change. Derived from the stored version stamp on read, so a new
    /// release gets one more attempt at each of them.
    #[serde(default)]
    pub bpm_absent: bool,
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
    /// Raw image bytes, base64-encoded. Written by the undo path, which
    /// captures the cover a write is about to replace and has nowhere on disk
    /// to point at.
    Data { base64: String },
}

impl Default for CoverInput {
    fn default() -> Self {
        CoverInput::Keep
    }
}

/// One file to (re)write tags into, with its full confirmed metadata.
///
/// Also the shape an undo restores, which is deliberate: undoing a tag write
/// *is* a tag write, so the stored entry can be handed straight back to
/// `write_metadata` without a translation step in between.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WriteMetadataItem {
    pub path: String,
    pub metadata: TrackMetadata,
    #[serde(default)]
    pub cover: Option<CoverInput>,
    /// Embed the cover bytes exactly as given, without the CDJ re-encode.
    ///
    /// Set only by the undo snapshot, whose whole promise is that the file ends
    /// up where it started — and re-encoding the artwork it captured would put
    /// back a picture that merely looks the same. An added field rather than a
    /// `CoverInput` variant on purpose: serde ignores a field it does not know,
    /// so an older build reading a newer undo entry falls back to the behaviour
    /// it always had, where a new variant would fail to deserialize outright.
    #[serde(default)]
    pub cover_verbatim: bool,
}

/// One group of files written together, and therefore undone together.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UndoEntry {
    /// Row id, needed to pop exactly this entry again.
    pub id: i64,
    /// What the write was, in the user's terms ("12 tracks", a filename).
    pub label: String,
    pub items: Vec<WriteMetadataItem>,
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

/// How much attention an event deserves. Three levels, because the panel sorts
/// by "can I ignore this": a finished scan, a file that was left out, a
/// operation that did not happen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EventLevel {
    Info,
    Warn,
    Error,
}

impl EventLevel {
    /// The stored form. Spelled out rather than derived so a rename of the
    /// variant cannot silently orphan the rows already in the database.
    pub fn as_str(self) -> &'static str {
        match self {
            EventLevel::Info => "info",
            EventLevel::Warn => "warn",
            EventLevel::Error => "error",
        }
    }

    /// Reads a stored level back. Anything unknown counts as `Info`: a row from
    /// a future version is still worth showing, just not worth alarming about.
    pub fn from_str(s: &str) -> Self {
        match s {
            "error" => EventLevel::Error,
            "warn" => EventLevel::Warn,
            _ => EventLevel::Info,
        }
    }
}

/// One line in the event log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppEvent {
    pub id: i64,
    pub created_ms: i64,
    pub level: EventLevel,
    /// Which part of the app produced it ("scan", "convert", …). Free-form on
    /// purpose: it is a label in a panel, not something to branch on.
    pub source: String,
    pub message: String,
    pub detail: Option<String>,
}

/// The event log plus how far the user has read, in one read: the badge needs
/// both, and fetching them separately could only ever disagree.
#[derive(Debug, Clone, Serialize)]
pub struct EventLog {
    pub events: Vec<AppEvent>,
    /// Id of the newest event already seen; 0 for a log never opened.
    pub seen_id: i64,
}

/// A file the analysis could not use, and why. Reported rather than dropped:
/// a scan over a mixed collection always meets a few of these, and "the scan
/// finished but three files are missing from the list" is not something the
/// user can act on without the reason.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkippedFile {
    pub path: String,
    pub file_name: String,
    pub reason: String,
}

/// Outcome of re-pointing a library folder at a new location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RelocateResult {
    /// Rows rewritten to the new root.
    pub moved: usize,
    /// Rows left untouched because the file is not under the new root (or a row
    /// for that path already exists). They keep pointing at the old location.
    pub skipped: usize,
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
            bpm: None,
            has_cover: true,
        }
    }

    #[test]
    fn is_complete_true_when_all_text_fields_set() {
        assert!(full_metadata().is_complete());
    }

    #[test]
    fn is_complete_ignores_optional_catalog_label_genre_year_and_bpm() {
        // catalog_number, label, genre, year and bpm are intentionally optional
        // — most files have no BPM tag, and they are not "incomplete" for it.
        let mut md = full_metadata();
        md.genre = None;
        md.year = None;
        assert!(md.catalog_number.is_none() && md.label.is_none() && md.bpm.is_none());
        assert!(md.is_complete());
    }

    #[test]
    fn is_complete_false_when_a_field_missing_or_blank() {
        let mut md = full_metadata();
        md.album = None;
        assert!(!md.is_complete());

        let mut md = full_metadata();
        md.album_artist = Some("   ".into());
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
