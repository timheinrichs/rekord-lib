use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::ItemKey;

use crate::error::{AppError, AppResult};
use crate::models::TrackMetadata;

/// Reads a file's existing metadata via lofty.
/// Files without tags return an empty [`TrackMetadata`].
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
        md.catalog_number =
            non_empty(tag.get_string(&ItemKey::CatalogNumber).map(|s| s.to_string()));
        md.label = non_empty(tag.get_string(&ItemKey::Label).map(|s| s.to_string()));
        md.country = non_empty(
            tag.get_string(&ItemKey::from_key(tag.tag_type(), "RELEASECOUNTRY"))
                .map(|s| s.to_string()),
        );
        md.bpm = bpm_of(tag);
        md.has_cover = !tag.pictures().is_empty();
    }

    // No embedded cover? Then a cover image in the folder counts too
    // (it gets embedded automatically on conversion).
    if !md.has_cover {
        md.has_cover = crate::metadata::write::has_sidecar_cover(path);
    }

    Ok(md)
}

fn non_empty(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.trim().is_empty())
}

/// Reads the BPM from whichever key the tag format uses. Both variants are
/// tried because lofty maps only `IntegerBpm` for ID3v2 (`TBPM`) but only
/// `Bpm` for Vorbis comments. Values are parsed leniently: taggers write
/// "128", "128.00" and "128,0" alike, and the fraction is kept.
pub(crate) fn bpm_of(tag: &lofty::tag::Tag) -> Option<f64> {
    for key in [ItemKey::IntegerBpm, ItemKey::Bpm] {
        if let Some(raw) = tag.get_string(&key) {
            if let Some(bpm) = parse_bpm(raw) {
                return Some(bpm);
            }
        }
    }
    None
}

/// "128.00" -> 128.0, "128,5" -> 128.5, " 128 " -> 128.0. Rejects 0 and
/// implausible values.
///
/// The decimals are kept rather than rounded away: Rekordbox writes fractional
/// tempos, and rounding on read would silently rewrite the user's own value the
/// next time we save the tag.
fn parse_bpm(raw: &str) -> Option<f64> {
    let cleaned = raw.trim().replace(',', ".");
    let value: f64 = cleaned.parse().ok()?;
    if !value.is_finite() || value < 1.0 || value > 1000.0 {
        return None;
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::parse_bpm;

    #[test]
    fn parses_the_shapes_taggers_actually_write() {
        assert_eq!(parse_bpm("128"), Some(128.0));
        assert_eq!(parse_bpm("128.00"), Some(128.0));
        // The fraction survives — this used to round to 128 and throw away
        // exactly what Rekordbox had stored.
        assert_eq!(parse_bpm("127,6"), Some(127.6));
        assert_eq!(parse_bpm("128.53"), Some(128.53));
        assert_eq!(parse_bpm("  174 "), Some(174.0));
    }

    #[test]
    fn rejects_junk_and_implausible_values() {
        assert_eq!(parse_bpm(""), None);
        assert_eq!(parse_bpm("n/a"), None);
        assert_eq!(parse_bpm("0"), None);
        assert_eq!(parse_bpm("-120"), None);
        assert_eq!(parse_bpm("99999"), None);
    }
}
