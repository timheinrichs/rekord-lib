use serde::{Deserialize, Serialize};

/// Zielformat der Konvertierung. Default ist AIFF (universell CDJ-kompatibel).
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
    /// Dateiendung des Zielcontainers.
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

    /// PCM-basierte Formate akzeptieren eine wählbare Bit-Tiefe.
    #[allow(dead_code)] // wird in Phase 2 (Metadaten/Cover) genutzt
    pub fn is_pcm(&self) -> bool {
        matches!(self, TargetFormat::Aiff | TargetFormat::Wav)
    }

    /// Läuft dieses Format nur auf neueren Playern (CDJ-3000/NXS2)?
    #[allow(dead_code)] // wird in Phase 2 genutzt
    pub fn newer_players_only(&self) -> bool {
        matches!(self, TargetFormat::Flac | TargetFormat::Alac)
    }
}

/// Technische Audio-Eigenschaften aus ffprobe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioInfo {
    pub container: String,
    pub codec: String,
    pub sample_rate: u32,
    /// Bit-Tiefe bei PCM; 0 wenn unbekannt/verlustbehaftet.
    pub bits_per_sample: u32,
    pub channels: u32,
    pub duration_secs: f64,
    pub lossless: bool,
}

/// Aus der Datei ausgelesene Metadaten.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TrackMetadata {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<String>,
    pub track_number: Option<u32>,
    pub has_cover: bool,
}

impl TrackMetadata {
    /// Sind alle für Rekordbox relevanten Textfelder gesetzt?
    /// (Titel, Artist, Album, Album-Artist, Genre, Jahr)
    pub fn is_complete(&self) -> bool {
        fn filled(v: &Option<String>) -> bool {
            v.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false)
        }
        filled(&self.title)
            && filled(&self.artist)
            && filled(&self.album)
            && filled(&self.album_artist)
            && filled(&self.genre)
            && filled(&self.year)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

/// Ein einzelnes Kompatibilitätsproblem der Quelldatei.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatIssue {
    pub code: String,
    pub message: String,
    pub severity: Severity,
}

/// Kompatibilitätsbericht: ist die Datei bereits auf allen CDJ/XDJ lauffähig?
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatReport {
    /// true = ohne Konvertierung auf allen Playern lauffähig.
    pub compatible: bool,
    pub issues: Vec<CompatIssue>,
}

/// Gesamtergebnis der Analyse einer Datei.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackAnalysis {
    pub id: String,
    pub path: String,
    pub file_name: String,
    pub audio: AudioInfo,
    pub metadata: TrackMetadata,
    pub compat: CompatReport,
    /// true wenn Pflicht-Metadaten fehlen und Vorschläge sinnvoll wären.
    pub metadata_incomplete: bool,
}

/// Optionen für einen Konvertierungslauf.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertOptions {
    pub format: TargetFormat,
    /// 16 oder 24 (nur relevant für PCM/FLAC/ALAC).
    #[serde(default = "default_bit_depth")]
    pub bit_depth: u32,
    /// Zielordner; wenn leer, wird neben die Quelldatei geschrieben.
    #[serde(default)]
    pub output_dir: Option<String>,
    /// Sonderzeichen im Dateinamen bereinigen.
    #[serde(default)]
    pub sanitize_filenames: bool,
}

fn default_bit_depth() -> u32 {
    16
}

/// Herkunft des einzubettenden Covers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CoverInput {
    /// Vorhandenes Cover der Quelldatei beibehalten.
    Keep,
    /// Kein Cover einbetten.
    None,
    /// Cover von der Cover Art Archive über eine MusicBrainz-Release-ID.
    Musicbrainz { release_id: String },
    /// Cover aus einer lokalen Bilddatei.
    File { path: String },
}

impl Default for CoverInput {
    fn default() -> Self {
        CoverInput::Keep
    }
}

/// Ein einzelner Konvertierungsauftrag (kann bestätigte Metadaten enthalten).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertJob {
    pub id: String,
    pub path: String,
    /// Vom Nutzer bestätigte Metadaten (Phase 2); None = bestehende beibehalten.
    #[serde(default)]
    pub metadata: Option<TrackMetadata>,
    /// Cover-Quelle; None wird wie `Keep` behandelt.
    #[serde(default)]
    pub cover: Option<CoverInput>,
}

/// Ein Kandidat aus der MusicBrainz-Suche.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MbCandidate {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<String>,
    pub genre: Option<String>,
    pub track_number: Option<u32>,
    /// MusicBrainz-Release-ID für den Cover-Abruf.
    pub release_id: Option<String>,
    /// MusicBrainz-Score 0..100.
    pub score: u32,
}

/// Vorschläge für die Metadaten einer Datei zur manuellen Bestätigung.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MetadataSuggestions {
    pub id: String,
    /// Aktuell in der Datei vorhandene Tags.
    pub current: TrackMetadata,
    /// Aus Dateiname/Ordner abgeleitete Vermutung.
    pub filename_guess: TrackMetadata,
    /// Treffer aus der MusicBrainz-Datenbank (kann leer sein).
    pub candidates: Vec<MbCandidate>,
}

/// Ergebnis pro konvertierter Datei.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConvertResult {
    pub id: String,
    pub source_path: String,
    pub output_path: Option<String>,
    pub success: bool,
    pub error: Option<String>,
}

/// Verbundenes Bandcamp-Konto.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BandcampAccount {
    pub username: String,
    pub fan_id: i64,
}

/// Ein Eintrag aus der Bandcamp-Sammlung (gekauftes Album/Track).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BandcampItem {
    /// Eindeutiger Schlüssel (sale_item_type + sale_item_id), z. B. "p12345".
    pub key: String,
    pub title: String,
    pub band_name: String,
    /// "album" oder "track".
    pub item_type: String,
    /// Thumbnail-URL (bcbits) oder None.
    pub art_url: Option<String>,
    /// Download-Seite (aus redownload_urls); None wenn (noch) nicht ladbar.
    pub download_page_url: Option<String>,
}

/// Ergebnis eines Bandcamp-Downloads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BandcampDownloadResult {
    pub key: String,
    /// Heruntergeladene (und ggf. entpackte) Audiodateien.
    pub files: Vec<String>,
    pub success: bool,
    pub error: Option<String>,
}
