use std::path::Path;

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::metadata::read::read_metadata;
use crate::metadata::{discogs, net};
use crate::models::{FieldSuggestions, MbCandidate, MetadataSuggestions, TrackMetadata};

/// Appends a trimmed, non-empty, case-insensitively-unique value.
fn push_unique(list: &mut Vec<String>, value: &str) {
    let v = value.trim();
    if !v.is_empty() && !list.iter().any(|e| e.eq_ignore_ascii_case(v)) {
        list.push(v.to_string());
    }
}

/// Derives a metadata guess from the filename and parent folder.
///
/// Supported patterns (typical for underground/Bandcamp files):
/// `NN - Artist - Title`, `Artist - Title`, `NN Title`, `Title`.
/// The album is derived from the folder name.
pub fn parse_filename(path: &str) -> TrackMetadata {
    let p = Path::new(path);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let mut md = TrackMetadata::default();

    // Strip a leading track number: "01 - ", "1. ", "07_"
    let (track_number, rest) = split_leading_track(&stem);
    md.track_number = track_number;

    // Split on " - ".
    let parts: Vec<&str> = rest.split(" - ").map(str::trim).collect();
    match parts.as_slice() {
        [artist, title] => {
            md.artist = non_empty(artist);
            md.title = non_empty(title);
        }
        [artist, album, title] => {
            md.artist = non_empty(artist);
            md.album = non_empty(album);
            md.title = non_empty(title);
        }
        [title] => {
            md.title = non_empty(title);
        }
        _ => {
            md.title = non_empty(rest.trim());
        }
    }

    // Album from the folder name, if not set yet.
    if md.album.is_none() {
        if let Some(folder) = p
            .parent()
            .and_then(|d| d.file_name())
            .and_then(|s| s.to_str())
        {
            md.album = non_empty(&clean_folder(folder));
        }
    }

    md
}

/// Strips a leading track number and returns (number, rest).
fn split_leading_track(s: &str) -> (Option<u32>, String) {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 3 {
        return (None, s.to_string());
    }
    let after = &s[digits.len()..];
    let trimmed = after.trim_start_matches([' ', '.', '_', '-']);
    // Only treat it as a track number if a separator followed.
    if after.len() != trimmed.len() {
        (digits.parse::<u32>().ok(), trimmed.to_string())
    } else {
        (None, s.to_string())
    }
}

/// Removes year/catalog prefixes from folder names, e.g. "(2021) Album".
fn clean_folder(name: &str) -> String {
    let name = name.trim();
    let name = name
        .trim_start_matches(|c: char| c.is_ascii_digit() || " ()[]-_.".contains(c));
    name.trim().to_string()
}

fn non_empty(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Searches MusicBrainz for candidates based on artist/title.
pub async fn search_musicbrainz(
    client: &reqwest::Client,
    artist: Option<&str>,
    title: Option<&str>,
) -> AppResult<Vec<MbCandidate>> {
    let title = match title {
        Some(t) if !t.trim().is_empty() => t.trim(),
        _ => return Ok(Vec::new()), // no useful search without a title
    };

    let query = match artist {
        Some(a) if !a.trim().is_empty() => {
            format!("recording:\"{}\" AND artist:\"{}\"", title, a.trim())
        }
        _ => format!("recording:\"{}\"", title),
    };

    let resp = client
        .get("https://musicbrainz.org/ws/2/recording")
        .query(&[
            ("query", query.as_str()),
            ("fmt", "json"),
            ("limit", "5"),
        ])
        .send()
        .await
        .map_err(|e| AppError::Metadata(format!("MusicBrainz query failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Metadata(format!(
            "MusicBrainz HTTP {}",
            resp.status()
        )));
    }

    let json: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Metadata(e.to_string()))?;

    let recordings = json
        .get("recordings")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let candidates = recordings
        .iter()
        .map(parse_recording)
        .collect::<Vec<_>>();

    Ok(candidates)
}

/// Converts a MusicBrainz recording entry into a candidate.
fn parse_recording(rec: &Value) -> MbCandidate {
    let title = rec.get("title").and_then(Value::as_str).map(String::from);

    let artist = rec
        .get("artist-credit")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .and_then(|c| c.get("name"))
        .and_then(Value::as_str)
        .map(String::from);

    let release = rec
        .get("releases")
        .and_then(Value::as_array)
        .and_then(|r| r.first());

    let album = release
        .and_then(|r| r.get("title"))
        .and_then(Value::as_str)
        .map(String::from);

    let release_id = release
        .and_then(|r| r.get("id"))
        .and_then(Value::as_str)
        .map(String::from);

    let year = release
        .and_then(|r| r.get("date"))
        .and_then(Value::as_str)
        .map(|d| d.chars().take(4).collect::<String>())
        .filter(|y| y.len() == 4);

    let genre = rec
        .get("tags")
        .and_then(Value::as_array)
        .and_then(|tags| {
            tags.iter().max_by_key(|t| {
                t.get("count").and_then(Value::as_u64).unwrap_or(0)
            })
        })
        .and_then(|t| t.get("name"))
        .and_then(Value::as_str)
        .map(String::from);

    let score = rec
        .get("score")
        .and_then(Value::as_u64)
        .unwrap_or(0) as u32;

    MbCandidate {
        title,
        artist,
        album,
        year,
        genre,
        track_number: None,
        release_id,
        score,
    }
}

/// Builds suggestions for a file: existing tags, filename guess, MusicBrainz
/// candidates and aggregated per-field suggestions (Discogs + MusicBrainz).
pub async fn suggest(
    path: &str,
    discogs_key: &str,
    discogs_secret: &str,
) -> AppResult<MetadataSuggestions> {
    let current = read_metadata(path).unwrap_or_default();
    let filename_guess = parse_filename(path);

    // Best possible query basis: existing tags before the filename guess.
    let title = current
        .title
        .clone()
        .or_else(|| filename_guess.title.clone());
    let artist = current
        .artist
        .clone()
        .or_else(|| filename_guess.artist.clone());
    let album = current
        .album
        .clone()
        .or_else(|| filename_guess.album.clone());

    let candidates = match net::client() {
        Ok(client) => search_musicbrainz(&client, artist.as_deref(), title.as_deref())
            .await
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    // Discogs per-field suggestions (empty without credentials / on error).
    let dc = discogs::search(
        discogs_key,
        discogs_secret,
        artist.as_deref(),
        title.as_deref(),
        album.as_deref(),
    )
    .await;

    // Discogs first, then MusicBrainz genre/year folded in as extra chips.
    let mut field_suggestions = FieldSuggestions {
        genres: dc.genres,
        years: dc.years,
        labels: dc.labels,
        countries: dc.countries,
    };
    for c in &candidates {
        if let Some(g) = c.genre.as_deref() {
            push_unique(&mut field_suggestions.genres, g);
        }
        if let Some(y) = c.year.as_deref() {
            push_unique(&mut field_suggestions.years, y);
        }
    }

    Ok(MetadataSuggestions {
        id: path.to_string(),
        current,
        filename_guess,
        candidates,
        field_suggestions,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_track_artist_title_with_number() {
        let md = parse_filename("/music/Some Album/01 - Aphex Twin - Xtal.flac");
        assert_eq!(md.track_number, Some(1));
        assert_eq!(md.artist.as_deref(), Some("Aphex Twin"));
        assert_eq!(md.title.as_deref(), Some("Xtal"));
        assert_eq!(md.album.as_deref(), Some("Some Album"));
    }

    #[test]
    fn parse_artist_title() {
        let md = parse_filename("/x/Boards of Canada - Roygbiv.mp3");
        assert_eq!(md.artist.as_deref(), Some("Boards of Canada"));
        assert_eq!(md.title.as_deref(), Some("Roygbiv"));
        assert_eq!(md.track_number, None);
    }

    #[test]
    fn parse_artist_album_title_triplet() {
        let md = parse_filename("/x/Artist - Album - Title.wav");
        assert_eq!(md.artist.as_deref(), Some("Artist"));
        assert_eq!(md.album.as_deref(), Some("Album"));
        assert_eq!(md.title.as_deref(), Some("Title"));
    }

    #[test]
    fn parse_title_only_takes_album_from_folder() {
        let md = parse_filename("/music/(2021) Deep Cuts/Just A Title.aiff");
        assert_eq!(md.title.as_deref(), Some("Just A Title"));
        assert_eq!(md.album.as_deref(), Some("Deep Cuts"));
    }

    #[test]
    fn split_leading_track_various() {
        assert_eq!(split_leading_track("01 - Rest"), (Some(1), "Rest".to_string()));
        assert_eq!(split_leading_track("007_Song"), (Some(7), "Song".to_string()));
        // too many digits -> not a track number
        assert_eq!(
            split_leading_track("123456 Song"),
            (None, "123456 Song".to_string())
        );
        // no separator after the digits -> not a track number
        assert_eq!(split_leading_track("2step"), (None, "2step".to_string()));
    }

    #[test]
    fn clean_folder_strips_year_and_catalog_prefixes() {
        assert_eq!(clean_folder("(2021) Album"), "Album");
        assert_eq!(clean_folder("2020 - Album"), "Album");
        assert_eq!(clean_folder("[001] Album"), "Album");
        assert_eq!(clean_folder("Album"), "Album");
    }
}
