use serde::{Serialize, Serializer};

/// Application-wide error type. Serializes to a plain string so the frontend
/// receives a readable message from any failing command.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("ffprobe/ffmpeg konnte nicht ausgeführt werden: {0}")]
    Sidecar(String),

    #[error("Datei konnte nicht analysiert werden: {0}")]
    Probe(String),

    #[error("Konvertierung fehlgeschlagen: {0}")]
    Convert(String),

    #[error("Metadaten-Fehler: {0}")]
    Metadata(String),

    #[error("Bandcamp: {0}")]
    Bandcamp(String),

    #[error("E/A-Fehler: {0}")]
    Io(#[from] std::io::Error),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
