use std::time::Duration;

use crate::error::{AppError, AppResult};

/// MusicBrainz/Cover-Art-Archive verlangen einen aussagekräftigen User-Agent.
const USER_AGENT: &str = "rekord-lib/0.1.0 (https://github.com/timheinrichs/rekord-lib)";

/// Baut einen HTTP-Client mit passendem User-Agent und kurzem Timeout
/// (für API-/Metadaten-Abfragen).
pub fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::Metadata(format!("HTTP-Client-Fehler: {e}")))
}

/// Client für (potenziell große) Datei-Downloads: nur Connect-Timeout,
/// kein Gesamt-Timeout, da Alben mehrere hundert MB haben können.
pub fn download_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Metadata(format!("HTTP-Client-Fehler: {e}")))
}
