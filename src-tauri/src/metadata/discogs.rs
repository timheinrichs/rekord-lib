use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::metadata::net;

/// Max suggestions kept per field (to avoid chip overload in the UI).
const MAX_PER_FIELD: usize = 8;

/// Per-field suggestion lists aggregated from a Discogs release search.
#[derive(Debug, Clone, Default)]
pub struct DiscogsAggregate {
    pub genres: Vec<String>,
    pub years: Vec<String>,
    pub labels: Vec<String>,
    pub countries: Vec<String>,
}

/// How a request identifies itself to Discogs.
///
/// The API takes either the user's own personal access token or a registered
/// application's consumer key and secret, and treats both the same way for
/// public data: 60 requests per minute instead of 25. The token is the lighter
/// of the two — a string copied from a settings page rather than an application
/// somebody has to register — which is why settings offers it first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Credential {
    /// A personal access token, belonging to the user.
    Token(String),
    /// A registered application's consumer key and secret.
    App { key: String, secret: String },
}

impl Credential {
    /// The `Authorization` header value Discogs expects for this form.
    pub fn header(&self) -> String {
        match self {
            Credential::Token(token) => format!("Discogs token={token}"),
            Credential::App { key, secret } => format!("Discogs key={key}, secret={secret}"),
        }
    }
}

/// What a search returned, and whether Discogs turned it away.
#[derive(Debug, Clone, Default)]
pub struct SearchOutcome {
    pub aggregate: DiscogsAggregate,
    /// An unauthenticated request was refused — see `refused`.
    pub denied: bool,
}

/// Whether a failed response means "this needs credentials".
///
/// Discogs documents `/database/search` as requiring authentication, but
/// answers unauthenticated requests all the same (measured 2026-08-26, at the
/// lower 25/min limit). The app relies on that, so it has to notice the day it
/// stops being true: a 401/403 on a request that carried **no** credentials is
/// exactly that day, and is worth saying out loud. The same status on an
/// authenticated request means the stored credential is wrong instead, which
/// settings already lets the user fix.
fn refused(status: reqwest::StatusCode, authenticated: bool) -> bool {
    !authenticated
        && (status == reqwest::StatusCode::UNAUTHORIZED
            || status == reqwest::StatusCode::FORBIDDEN)
}

/// Searches Discogs releases and aggregates per-field suggestions.
///
/// Credentials are optional: without them the search still runs, at the lower
/// rate limit Discogs applies to anonymous callers. Any error (HTTP failure,
/// bad JSON) yields empty suggestions — never fails.
pub async fn search(
    cred: Option<&Credential>,
    artist: Option<&str>,
    title: Option<&str>,
    album: Option<&str>,
) -> SearchOutcome {
    try_search(cred, artist, title, album)
        .await
        .unwrap_or_default()
}

async fn try_search(
    cred: Option<&Credential>,
    artist: Option<&str>,
    title: Option<&str>,
    album: Option<&str>,
) -> AppResult<SearchOutcome> {
    let client = net::client()?;

    let mut params: Vec<(&str, String)> =
        vec![("type", "release".into()), ("per_page", "25".into())];
    if let Some(a) = artist.filter(|s| !s.trim().is_empty()) {
        params.push(("artist", a.trim().to_string()));
    }
    if let Some(t) = title.filter(|s| !s.trim().is_empty()) {
        params.push(("track", t.trim().to_string()));
    }
    if let Some(al) = album.filter(|s| !s.trim().is_empty()) {
        params.push(("release_title", al.trim().to_string()));
    }

    let mut req = client.get("https://api.discogs.com/database/search");
    if let Some(cred) = cred {
        req = req.header(reqwest::header::AUTHORIZATION, cred.header());
    }
    let resp = req
        .query(&params)
        .send()
        .await
        .map_err(|e| AppError::Metadata(format!("Discogs request: {e}")))?;

    if !resp.status().is_success() {
        return Ok(SearchOutcome {
            aggregate: DiscogsAggregate::default(),
            denied: refused(resp.status(), cred.is_some()),
        });
    }
    let json: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Metadata(format!("Discogs JSON: {e}")))?;
    Ok(SearchOutcome {
        aggregate: aggregate(&json),
        denied: false,
    })
}

/// Adds a trimmed, non-empty value if not already present (case-insensitive),
/// keeping the first-seen spelling and capping the list length.
fn push_unique(list: &mut Vec<String>, value: &str) {
    let v = value.trim();
    if v.is_empty() || list.len() >= MAX_PER_FIELD {
        return;
    }
    if list.iter().any(|e| e.eq_ignore_ascii_case(v)) {
        return;
    }
    list.push(v.to_string());
}

fn push_str_array(list: &mut Vec<String>, val: Option<&Value>) {
    if let Some(arr) = val.and_then(Value::as_array) {
        for item in arr {
            if let Some(s) = item.as_str() {
                push_unique(list, s);
            }
        }
    }
}

/// Four-digit year from a Discogs `year` field (number or string).
fn year_str(val: Option<&Value>) -> Option<String> {
    match val {
        Some(Value::Number(n)) => Some(n.to_string()),
        Some(Value::String(s)) => Some(s.chars().take(4).collect()),
        _ => None,
    }
    .filter(|y| y.len() == 4 && y.chars().all(|c| c.is_ascii_digit()))
}

/// Aggregates per-field suggestions from a Discogs search response JSON.
/// Genre = styles first (specific, e.g. "Deep House"), then genres.
pub fn aggregate(json: &Value) -> DiscogsAggregate {
    let results = json
        .get("results")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut agg = DiscogsAggregate::default();
    // Styles first across all results, then broad genres.
    for r in &results {
        push_str_array(&mut agg.genres, r.get("style"));
    }
    for r in &results {
        push_str_array(&mut agg.genres, r.get("genre"));
    }
    for r in &results {
        if let Some(y) = year_str(r.get("year")) {
            push_unique(&mut agg.years, &y);
        }
        push_str_array(&mut agg.labels, r.get("label"));
        if let Some(c) = r.get("country").and_then(Value::as_str) {
            push_unique(&mut agg.countries, c);
        }
    }
    agg
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn aggregate_styles_before_genres_and_dedupes() {
        let json = json!({
            "results": [
                {
                    "style": ["Deep House", "House"],
                    "genre": ["Electronic"],
                    "year": 1996,
                    "label": ["Z Records"],
                    "country": "UK"
                },
                {
                    "style": ["House"],
                    "genre": ["Electronic"],
                    "year": "1997-05",
                    "label": ["Z Records", "Nu Groove"],
                    "country": "UK"
                }
            ]
        });
        let a = aggregate(&json);
        // Styles first (Deep House, House), then genre (Electronic); deduped.
        assert_eq!(a.genres, vec!["Deep House", "House", "Electronic"]);
        assert_eq!(a.years, vec!["1996", "1997"]);
        assert_eq!(a.labels, vec!["Z Records", "Nu Groove"]);
        assert_eq!(a.countries, vec!["UK"]);
    }

    #[test]
    fn aggregate_empty_on_no_results() {
        let a = aggregate(&json!({}));
        assert!(a.genres.is_empty() && a.years.is_empty());
    }

    #[test]
    fn header_names_the_form_discogs_expects() {
        assert_eq!(
            Credential::Token("tok".into()).header(),
            "Discogs token=tok"
        );
        assert_eq!(
            Credential::App {
                key: "k".into(),
                secret: "s".into(),
            }
            .header(),
            "Discogs key=k, secret=s"
        );
    }

    #[test]
    fn only_an_anonymous_refusal_counts_as_denied() {
        use reqwest::StatusCode;
        // The day Discogs closes the anonymous search.
        assert!(refused(StatusCode::UNAUTHORIZED, false));
        assert!(refused(StatusCode::FORBIDDEN, false));
        // A stored credential that is wrong is a different problem, and the
        // user can already see and replace it in settings.
        assert!(!refused(StatusCode::UNAUTHORIZED, true));
        // Everything else is an ordinary bad day for the API.
        assert!(!refused(StatusCode::TOO_MANY_REQUESTS, false));
        assert!(!refused(StatusCode::INTERNAL_SERVER_ERROR, false));
    }
}
