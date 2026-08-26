use std::time::Duration;

use crate::error::{AppError, AppResult};

/// MusicBrainz, Discogs and the Cover Art Archive all require a meaningful
/// User-Agent, and Discogs asks for one that identifies the app to get the full
/// rate limit. The version comes from the crate rather than a literal: a
/// hand-written one goes stale silently, and a wrong version is what makes a
/// rate-limit block land on the wrong release.
const USER_AGENT: &str = concat!(
    "rekord-lib/",
    env!("CARGO_PKG_VERSION"),
    " (https://github.com/timheinrichs/rekord-lib)"
);

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
