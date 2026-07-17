use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::ItemKey;

use crate::error::{AppError, AppResult};
use crate::models::TrackMetadata;

/// Liest die vorhandenen Metadaten einer Datei via lofty.
/// Dateien ohne Tags liefern ein leeres [`TrackMetadata`].
pub fn read_metadata(path: &str) -> AppResult<TrackMetadata> {
    let tagged = read_from_path(path).map_err(|e| AppError::Metadata(e.to_string()))?;

    let mut md = TrackMetadata::default();

    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        md.title = non_empty(tag.title().map(|c| c.to_string()));
        md.artist = non_empty(tag.artist().map(|c| c.to_string()));
        md.album = non_empty(tag.album().map(|c| c.to_string()));
        md.genre = non_empty(tag.genre().map(|c| c.to_string()));
        md.year = tag.year().map(|y| y.to_string());
        md.track_number = tag.track();
        md.album_artist = non_empty(tag.get_string(&ItemKey::AlbumArtist).map(|s| s.to_string()));
        md.has_cover = !tag.pictures().is_empty();
    }

    Ok(md)
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.trim().is_empty())
}
