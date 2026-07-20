use std::time::Duration;

use crate::error::{AppError, AppResult};

/// MusicBrainz / Cover Art Archive require a meaningful User-Agent.
const USER_AGENT: &str = "rekord-lib/0.1.0 (https://github.com/timheinrichs/rekord-lib)";

/// Builds an HTTP client with a suitable User-Agent and a short timeout
/// (for API/metadata queries).
pub fn client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| AppError::Metadata(format!("HTTP client error: {e}")))
}

/// Client for (potentially large) file downloads: connect timeout only,
/// no overall timeout, since albums can be several hundred MB.
pub fn download_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| AppError::Metadata(format!("HTTP client error: {e}")))
}
