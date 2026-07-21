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

/// Searches Discogs releases and aggregates per-field suggestions. Requires the
/// app's consumer key + secret (Discogs `key`/`secret` auth). Any error (no
/// credentials, HTTP failure, bad JSON) yields empty suggestions — never fails.
pub async fn search(
    key: &str,
    secret: &str,
    artist: Option<&str>,
    title: Option<&str>,
    album: Option<&str>,
) -> DiscogsAggregate {
    if key.trim().is_empty() || secret.trim().is_empty() {
        return DiscogsAggregate::default();
    }
    try_search(key, secret, artist, title, album)
        .await
        .unwrap_or_default()
}

async fn try_search(
    key: &str,
    secret: &str,
    artist: Option<&str>,
    title: Option<&str>,
    album: Option<&str>,
) -> AppResult<DiscogsAggregate> {
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

    let resp = client
        .get("https://api.discogs.com/database/search")
        .header(
            reqwest::header::AUTHORIZATION,
            format!("Discogs key={key}, secret={secret}"),
        )
        .query(&params)
        .send()
        .await
        .map_err(|e| AppError::Metadata(format!("Discogs request: {e}")))?;

    if !resp.status().is_success() {
        return Ok(DiscogsAggregate::default());
    }
    let json: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Metadata(format!("Discogs JSON: {e}")))?;
    Ok(aggregate(&json))
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
}
