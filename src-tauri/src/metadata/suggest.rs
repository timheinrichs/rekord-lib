use std::path::Path;

use serde_json::Value;

use crate::error::{AppError, AppResult};
use crate::metadata::net;
use crate::metadata::read::read_metadata;
use crate::models::{MbCandidate, MetadataSuggestions, TrackMetadata};

/// Leitet aus Dateiname und übergeordnetem Ordner eine Metadaten-Vermutung ab.
///
/// Unterstützte Muster (typisch für Underground-/Bandcamp-Dateien):
/// `NN - Artist - Titel`, `Artist - Titel`, `NN Titel`, `Titel`.
/// Das Album wird aus dem Ordnernamen abgeleitet.
pub fn parse_filename(path: &str) -> TrackMetadata {
    let p = Path::new(path);
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let mut md = TrackMetadata::default();

    // Führende Tracknummer abtrennen: "01 - ", "1. ", "07_"
    let (track_number, rest) = split_leading_track(&stem);
    md.track_number = track_number;

    // Nach " - " aufteilen.
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

    // Album aus Ordnername, falls noch nicht gesetzt.
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

/// Trennt eine führende Tracknummer ab und gibt (Nummer, Rest) zurück.
fn split_leading_track(s: &str) -> (Option<u32>, String) {
    let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 3 {
        return (None, s.to_string());
    }
    let after = &s[digits.len()..];
    let trimmed = after.trim_start_matches([' ', '.', '_', '-']);
    // Nur als Tracknummer werten, wenn danach ein Trenner stand.
    if after.len() != trimmed.len() {
        (digits.parse::<u32>().ok(), trimmed.to_string())
    } else {
        (None, s.to_string())
    }
}

/// Entfernt Jahres-/Katalog-Präfixe aus Ordnernamen, z. B. "(2021) Album".
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

/// Sucht Kandidaten in MusicBrainz anhand von Artist/Titel.
pub async fn search_musicbrainz(
    client: &reqwest::Client,
    artist: Option<&str>,
    title: Option<&str>,
) -> AppResult<Vec<MbCandidate>> {
    let title = match title {
        Some(t) if !t.trim().is_empty() => t.trim(),
        _ => return Ok(Vec::new()), // ohne Titel keine sinnvolle Suche
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
        .map_err(|e| AppError::Metadata(format!("MusicBrainz-Abfrage fehlgeschlagen: {e}")))?;

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

/// Wandelt einen MusicBrainz-Recording-Eintrag in einen Kandidaten um.
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

/// Erstellt Vorschläge für eine Datei: vorhandene Tags, Dateiname-Vermutung
/// und MusicBrainz-Kandidaten.
pub async fn suggest(path: &str) -> AppResult<MetadataSuggestions> {
    let current = read_metadata(path).unwrap_or_default();
    let filename_guess = parse_filename(path);

    // Bestmögliche Query-Basis: vorhandene Tags vor Dateiname-Vermutung.
    let title = current
        .title
        .clone()
        .or_else(|| filename_guess.title.clone());
    let artist = current
        .artist
        .clone()
        .or_else(|| filename_guess.artist.clone());

    let candidates = match net::client() {
        Ok(client) => search_musicbrainz(&client, artist.as_deref(), title.as_deref())
            .await
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };

    Ok(MetadataSuggestions {
        id: path.to_string(),
        current,
        filename_guess,
        candidates,
    })
}
