use serde::{Serialize, Serializer};

/// Application-wide error type. Serializes to a plain string so the frontend
/// receives a readable message from any failing command.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("Failed to run ffprobe/ffmpeg: {0}")]
    Sidecar(String),

    #[error("Failed to analyze file: {0}")]
    Probe(String),

    #[error("Conversion failed: {0}")]
    Convert(String),

    #[error("Metadata error: {0}")]
    Metadata(String),

    #[error("Bandcamp: {0}")]
    Bandcamp(String),

    #[error("I/O error: {0}")]
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
