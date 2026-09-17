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
        // `Accessor::year` became `date`, over a `Timestamp` that can carry a
        // month and a day. The app's year is a free-form string and only ever
        // held a year, so the year component is all that is taken — and
        // measured, `date()` finds it in the legacy Vorbis `YEAR` field as well
        // as in `DATE`, so files this app tagged before 0.9.3 still read.
        md.year = tag.date().map(|d| d.year.to_string());
        md.track_number = tag.track();
        md.album_artist = non_empty(tag.get_string(ItemKey::AlbumArtist).map(|s| s.to_string()));
        md.catalog_number =
            non_empty(tag.get_string(ItemKey::CatalogNumber).map(|s| s.to_string()));
        md.label = non_empty(tag.get_string(ItemKey::Label).map(|s| s.to_string()));
        md.country = non_empty(
            // `ItemKey::ReleaseCountry` is new in 0.25, and it is the reason the
            // country reaches a file at all now — see the note in `write.rs`.
            tag.get_string(ItemKey::ReleaseCountry)
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
        if let Some(raw) = tag.get_string(key) {
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
    use lofty::prelude::*;
    use lofty::tag::items::Timestamp;
    use lofty::tag::{ItemKey, Tag, TagType};

    /// The year survived the move from `Accessor::year` to `date`, in both
    /// directions.
    ///
    /// lofty 0.25 writes the year as a recording date, where 0.22 wrote the
    /// legacy `ItemKey::Year` on a Vorbis tag. These are the two facts the
    /// upgrade rested on, measured before it was made and pinned here so a
    /// later version cannot quietly drop either: a year this app writes today
    /// reads back, **and** a year an older version of this app wrote still
    /// reads. A FLAC tagged by 0.9.2 carries `YEAR`; one tagged after carries
    /// `DATE`.
    #[test]
    fn the_year_reads_from_the_new_field_and_the_legacy_one() {
        let mut tag = Tag::new(TagType::VorbisComments);

        // What this app writes now.
        tag.set_date(Timestamp {
            year: 1997,
            month: None,
            day: None,
            hour: None,
            minute: None,
            second: None,
        });
        assert_eq!(tag.date().map(|d| d.year), Some(1997));

        // What an older version of this app left behind.
        let mut legacy = Tag::new(TagType::VorbisComments);
        legacy.insert_text(ItemKey::Year, "1997".to_string());
        assert_eq!(
            legacy.date().map(|d| d.year),
            Some(1997),
            "a year written before 0.9.3 must still read"
        );
    }

    /// Only the year component is taken, because only the year is stored.
    ///
    /// The app's year is a free-form `Option<String>` and a `Timestamp` can
    /// carry a month and a day. Nothing invents one, and a value that is not a
    /// bare year is dropped rather than guessed at — which is what
    /// `parse::<u16>` did before as `parse::<u32>`.
    #[test]
    fn a_timestamp_with_a_month_still_reads_as_its_year() {
        let mut tag = Tag::new(TagType::Id3v2);
        tag.set_date(Timestamp {
            year: 1997,
            month: Some(5),
            day: Some(17),
            hour: None,
            minute: None,
            second: None,
        });
        assert_eq!(tag.date().map(|d| d.year.to_string()), Some("1997".into()));
    }

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
