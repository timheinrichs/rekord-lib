use base64::Engine;
use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::items::Timestamp;
use lofty::tag::{ItemKey, Tag, TagExt, TagType};

use crate::error::{AppError, AppResult};
use crate::metadata::{artwork, net};
use crate::models::{CoverInput, TrackMetadata};

/// Reads the embedded front cover (or the first image) of a file.
pub fn read_cover_bytes(path: &str) -> Option<Vec<u8>> {
    let tagged = read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag
        .pictures()
        .iter()
        .find(|p| p.pic_type() == PictureType::CoverFront)
        .or_else(|| tag.pictures().first())?;
    Some(pic.data().to_vec())
}

/// Known cover filenames (without extension) and image extensions for sidecar covers.
const COVER_NAMES: &[&str] = &["cover", "folder", "front", "album", "artwork", "art", "albumart"];
const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

/// Looks for a cover image in the same folder as the audio file (e.g. cover.jpg).
/// Many collections store the album cover as a separate file instead of
/// embedding it.
pub fn find_sidecar_cover(source: &str) -> Option<Vec<u8>> {
    let dir = std::path::Path::new(source).parent()?;
    let mut images: Vec<std::path::PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.extension()
                    .and_then(|s| s.to_str())
                    .map(|e| COVER_EXTS.contains(&e.to_lowercase().as_str()))
                    .unwrap_or(false)
        })
        .collect();
    if images.is_empty() {
        return None;
    }
    images.sort();
    // Prefer known cover filenames, otherwise the first image in the folder.
    let pick = images
        .iter()
        .find(|p| {
            let stem = p
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            COVER_NAMES.iter().any(|n| stem == *n || stem.contains(n))
        })
        .or_else(|| images.first())?;
    std::fs::read(pick).ok()
}

/// Embedded cover, otherwise a cover image from the folder.
pub fn read_cover_or_sidecar(source: &str) -> Option<Vec<u8>> {
    read_cover_bytes(source).or_else(|| find_sidecar_cover(source))
}

/// Cheaply checks (without reading a file) whether the folder has a cover image.
pub fn has_sidecar_cover(source: &str) -> bool {
    let Some(dir) = std::path::Path::new(source).parent() else {
        return false;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|e| {
        let p = e.path();
        p.is_file()
            && p.extension()
                .and_then(|s| s.to_str())
                .map(|ext| COVER_EXTS.contains(&ext.to_lowercase().as_str()))
                .unwrap_or(false)
    })
}

/// Resolves the cover bytes for the chosen source (still unprocessed).
pub async fn resolve_cover(source: &str, cover: &CoverInput) -> AppResult<Option<Vec<u8>>> {
    match cover {
        CoverInput::None => Ok(None),
        CoverInput::Keep => Ok(read_cover_or_sidecar(source)),
        CoverInput::File { path } => {
            let bytes = std::fs::read(path)?;
            Ok(Some(bytes))
        }
        CoverInput::Data { base64 } => {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(base64)
                .map_err(|e| AppError::Metadata(format!("Could not decode cover: {e}")))?;
            Ok(Some(bytes))
        }
        CoverInput::Musicbrainz { release_id } => {
            let client = net::client()?;
            let bytes = artwork::fetch_musicbrainz_cover(&client, release_id).await?;
            Ok(Some(bytes))
        }
    }
}

/// Writes *only* the BPM into an existing file. Deliberately not routed through
/// [`finalize`]: that resolves and re-encodes the cover, and the scan's BPM pass
/// must touch nothing but this one tag on thousands of files.
pub fn write_bpm(path: &str, bpm: f64) -> AppResult<()> {
    let mut tagged = read_from_path(path).map_err(|e| AppError::Metadata(e.to_string()))?;
    if tagged.primary_tag().is_none() {
        let tag_type = tagged.file_type().primary_tag_type();
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| AppError::Metadata("no writable tag".into()))?;
    tag.insert_text(bpm_key(tag.tag_type()), format_bpm(bpm));
    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| AppError::Metadata(format!("Failed to write BPM: {e}")))
}

/// Writes confirmed metadata and/or cover into the (already converted) output
/// file. `metadata = None` leaves the text tags untouched; the cover is still
/// set according to `cover` (default: keep the existing cover).
pub async fn finalize(
    output: &str,
    source: &str,
    metadata: &Option<TrackMetadata>,
    cover: &CoverInput,
    clear_empty: bool,
) -> AppResult<()> {
    finalize_cover(output, source, metadata, cover, clear_empty, false).await
}

/// [`finalize`], plus the undo path's promise: `verbatim` embeds the resolved
/// bytes exactly as they are.
///
/// Undo captures the artwork a write is about to replace, and that artwork is
/// whatever the file held — a 3000 px PNG as easily as a cover this app made.
/// Re-encoding it would put back something that only looks the same, which is
/// the one thing undo may not do.
pub async fn finalize_cover(
    output: &str,
    source: &str,
    metadata: &Option<TrackMetadata>,
    cover: &CoverInput,
    clear_empty: bool,
    verbatim: bool,
) -> AppResult<()> {
    // 1. Obtain the cover and prepare it for CDJ — unless it already is, or
    //    unless it must not be touched at all.
    let cover_image = match resolve_cover(source, cover).await? {
        Some(bytes) => Some(prepare_cover(bytes, verbatim)?),
        None => None,
    };

    // Nothing to do if neither metadata nor cover is written.
    if metadata.is_none() && cover_image.is_none() && !matches!(cover, CoverInput::None) {
        // No cover found and no metadata -> nothing to write.
        return Ok(());
    }

    // 2. Open tags (create a new tag in the appropriate format if needed).
    let mut tagged =
        read_from_path(output).map_err(|e| AppError::Metadata(e.to_string()))?;
    if tagged.primary_tag().is_none() {
        let tag_type = tagged.file_type().primary_tag_type();
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| AppError::Metadata("no writable tag".into()))?;

    // 3. Set text fields (only if confirmed). With `clear_empty`, an empty
    //    field removes the tag instead of leaving the old value — needed so an
    //    undo can restore a field that used to be empty.
    if let Some(md) = metadata {
        // The country used to go through `ItemKey::from_key(tag_type,
        // "RELEASECOUNTRY")`, which 0.22 resolved to `ItemKey::Unknown(..)`
        // because it had no `ReleaseCountry` at all — and `insert_text` of an
        // unknown key is a **silent no-op**. Measured on all five formats: the
        // item never reached the file. So a country the user typed lived in the
        // database and the Rekordbox export and nowhere else, for every release
        // up to 0.9.2.
        //
        // 0.25 has the key as a first-class variant, mapped per format, and
        // `insert_text` returns true. `ffprobe` reads back
        // "MusicBrainz Album Release Country" on ID3v2/MP4 and
        // "RELEASECOUNTRY" on Vorbis — the names Picard and the rest of the
        // ecosystem use. The upgrade fixes the no-op as a side effect, which is
        // why this one is called out in the changelog.
        // (field value, its ItemKey) for the text fields.
        let text: [(&Option<String>, ItemKey); 8] = [
            (&md.title, ItemKey::TrackTitle),
            (&md.artist, ItemKey::TrackArtist),
            (&md.album, ItemKey::AlbumTitle),
            (&md.genre, ItemKey::Genre),
            (&md.album_artist, ItemKey::AlbumArtist),
            (&md.catalog_number, ItemKey::CatalogNumber),
            (&md.label, ItemKey::Label),
            (&md.country, ItemKey::ReleaseCountry),
        ];
        for (value, key) in text {
            match clean(value) {
                Some(v) => {
                    tag.insert_text(key, v);
                }
                None if clear_empty => {
                    tag.remove_key(key);
                }
                None => {}
            }
        }
        // `set_year` became `set_date` over a `Timestamp`. Only the year
        // component is ever set, because that is all the app has — its year is
        // a free-form string, and anything that is not a bare year (Discogs
        // hands back "1997-05") has always been dropped here rather than
        // guessed at.
        //
        // Removal goes through `remove_date` rather than `remove_key`: the
        // written item is the recording date, and on a Vorbis tag written by an
        // older version the value sits in the legacy `YEAR` field instead.
        // Measured — `remove_date` clears both, `remove_key(ItemKey::Year)`
        // would have left one of them behind depending on who wrote the file.
        match md.year.as_ref().and_then(|s| s.trim().parse::<u16>().ok()) {
            Some(y) => tag.set_date(Timestamp {
                year: y,
                month: None,
                day: None,
                hour: None,
                minute: None,
                second: None,
            }),
            None if clear_empty => {
                tag.remove_date();
            }
            None => {}
        }
        match md.track_number {
            Some(n) => tag.set_track(n),
            None if clear_empty => {
                tag.remove_key(ItemKey::TrackNumber);
            }
            None => {}
        }
        // BPM is numeric but has no dedicated lofty setter, and the right key
        // depends on the format: lofty maps `IntegerBpm` for ID3v2/MP4 and
        // `Bpm` for Vorbis comments. Using the wrong one is a silent no-op.
        let bpm_key = bpm_key(tag.tag_type());
        match md.bpm {
            Some(n) => {
                tag.insert_text(bpm_key, format_bpm(n));
            }
            None if clear_empty => {
                tag.remove_key(ItemKey::IntegerBpm);
                tag.remove_key(ItemKey::Bpm);
            }
            None => {}
        }
    }

    // 4. Embed the cover, or strip it when the write asks for no cover.
    apply_cover(tag, cover_image, cover);

    // 5. Save.
    tag.save_to_path(output, WriteOptions::default())
        .map_err(|e| AppError::Metadata(format!("Failed to write tags: {e}")))?;

    Ok(())
}

/// Applies the resolved cover to `tag`: `Some(bytes)` replaces the front cover,
/// `None` together with [`CoverInput::None`] strips the embedded artwork.
///
/// Stripping removes *every* picture, not just `CoverFront`: [`read_cover_bytes`]
/// falls back to the first picture of any type, so a leftover picture would keep
/// showing up as the track's cover and "no cover" would look like a no-op.
/// The cover as it will be embedded: the bytes, and what they actually are.
type CoverImage = (Vec<u8>, MimeType);

/// Decides whether a cover still has to go through the encoder.
///
/// Three cases, and only the first is new work: bytes that must not be touched
/// (an undo restoring what the file held), bytes that are already exactly what
/// the encoder would produce, and everything else.
fn prepare_cover(bytes: Vec<u8>, verbatim: bool) -> AppResult<CoverImage> {
    if verbatim {
        // The mime has to be read off the bytes rather than assumed: what a file
        // held before a write is not necessarily a JPEG, and claiming otherwise
        // would embed a PNG that players then refuse to draw.
        if let Some(mime) = mime_of(&bytes) {
            return Ok((bytes, mime));
        }
        // Not an image we can name. Better a re-encoded cover than a picture
        // labelled as something it is not.
    } else if artwork::already_cdj_shaped(&bytes) {
        return Ok((bytes, MimeType::Jpeg));
    }
    Ok((artwork::process_cover(&bytes)?, MimeType::Jpeg))
}

/// The image format of some bytes, by magic number. `None` for anything else,
/// which the caller treats as a reason to re-encode rather than to guess.
fn mime_of(bytes: &[u8]) -> Option<MimeType> {
    if bytes.starts_with(&[0xFF, 0xD8]) {
        Some(MimeType::Jpeg)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(MimeType::Png)
    } else {
        None
    }
}

fn apply_cover(tag: &mut Tag, cover_image: Option<CoverImage>, cover: &CoverInput) {
    match cover_image {
        Some((bytes, mime)) => {
            tag.remove_picture_type(PictureType::CoverFront);
            // `new_unchecked` became the `unchecked` builder. Still
            // unvalidated and still infallible, which is deliberate: one of the
            // five `CoverInput` sources is the undo path, replaying bytes this
            // app captured from a file it is about to overwrite. Validating
            // there would mean undo failing to restore artwork on a file that
            // was fine before. Validating the download and the user-picked file
            // would be worth doing, and is its own change.
            tag.push_picture(
                Picture::unchecked(bytes)
                    .pic_type(PictureType::CoverFront)
                    .mime_type(mime)
                    .build(),
            );
        }
        // lofty has no "clear all pictures"; removing the first one repeatedly
        // is the whole list.
        None if matches!(cover, CoverInput::None) => {
            while !tag.pictures().is_empty() {
                tag.remove_picture(0);
            }
        }
        None => {}
    }
}

fn clean(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// How a tempo is spelled in a tag: two decimals, the way Rekordbox writes it
/// ("128.00", "127.60"). A fixed number of decimals keeps the round trip stable
/// — read gives 128.0, write gives "128.00", read gives 128.0 again — so saving
/// a file twice does not keep changing its tag.
fn format_bpm(bpm: f64) -> String {
    format!("{bpm:.2}")
}

/// The BPM key the given tag format actually maps. lofty drops unmapped keys
/// silently on write, so a hardcoded `IntegerBpm` would never reach a FLAC.
fn bpm_key(tag_type: TagType) -> ItemKey {
    match tag_type {
        TagType::VorbisComments => ItemKey::Bpm,
        _ => ItemKey::IntegerBpm,
    }
}

/// Fixtures shared with other modules' tests.
#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// A WAV with `cover` embedded as its front picture, the way a write leaves
    /// one — so a test elsewhere has something to capture.
    pub fn wav_with_cover(path: &std::path::Path, cover: &[u8]) {
        std::fs::write(path, wav_bytes()).unwrap();
        let mut tagged = read_from_path(path).unwrap();
        if tagged.primary_tag().is_none() {
            let tag_type = tagged.file_type().primary_tag_type();
            tagged.insert_tag(Tag::new(tag_type));
        }
        let tag = tagged.primary_tag_mut().unwrap();
        tag.push_picture(
            Picture::unchecked(cover.to_vec())
                .pic_type(PictureType::CoverFront)
                .mime_type(MimeType::Jpeg)
                .build(),
        );
        tag.save_to_path(path, WriteOptions::default()).unwrap();
    }

    /// Smallest WAV lofty will parse: 16-bit mono PCM with a handful of samples.
    /// A minimal WAV.
    ///
    /// The sample count is not arbitrary. lofty 0.25.2 has an arithmetic bug
    /// when it rewrites the ID3v2 chunk of a RIFF file and the *new* tag is
    /// larger than the file's whole audio stream: `chunk_file.rs:105` does
    /// `updated_stream_len -= tag_chunk_size - existing_tag_len` where it should
    /// add, and the subtraction underflows and panics. Sixty-four samples plus a
    /// 1400×1400 cover hit it every time.
    ///
    /// Real audio cannot: a cover is never larger than the track it belongs to,
    /// and this was checked rather than assumed — a 300 KB cover into the 5 MB
    /// `plain.wav` fixture produces a file `ffprobe` reads back at the right
    /// duration and size. So the fixture carries a second of silence instead of
    /// 64 samples, which is still minimal and no longer tests the library's
    /// arithmetic instead of our undo.
    ///
    /// `a_cover_larger_than_the_audio_still_panics_upstream` pins the bug, so
    /// the day lofty fixes it the canary fails and this can shrink again.
    pub fn wav_bytes() -> Vec<u8> {
        // One second, mono, 16-bit, 44.1 kHz.
        wav_of(88_200)
    }

    /// The fixture as it used to be: a few dozen samples. Only the canary wants
    /// it, because only the canary is about the upstream bug.
    pub fn tiny_wav() -> Vec<u8> {
        wav_of(64)
    }

    fn wav_of(data_len: usize) -> Vec<u8> {
        let samples = vec![0u8; data_len];
        let mut fmt = Vec::new();
        fmt.extend_from_slice(&1u16.to_le_bytes()); // PCM
        fmt.extend_from_slice(&1u16.to_le_bytes()); // mono
        fmt.extend_from_slice(&44_100u32.to_le_bytes());
        fmt.extend_from_slice(&88_200u32.to_le_bytes());
        fmt.extend_from_slice(&2u16.to_le_bytes());
        fmt.extend_from_slice(&16u16.to_le_bytes());

        let mut body = Vec::new();
        body.extend_from_slice(b"WAVE");
        body.extend_from_slice(b"fmt ");
        body.extend_from_slice(&(fmt.len() as u32).to_le_bytes());
        body.extend_from_slice(&fmt);
        body.extend_from_slice(b"data");
        body.extend_from_slice(&(samples.len() as u32).to_le_bytes());
        body.extend_from_slice(&samples);

        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(body.len() as u32).to_le_bytes());
        wav.extend_from_slice(&body);
        wav
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// The formats this app writes: AIFF/WAV/MP3/AAC use ID3v2, M4A uses ilst,
    /// FLAC/Ogg use Vorbis comments.
    const WRITTEN_TAG_TYPES: [TagType; 3] = [
        TagType::Id3v2,
        TagType::Mp4Ilst,
        TagType::VorbisComments,
    ];

    #[test]
    fn bpm_key_is_actually_mapped_for_every_format_we_write() {
        for tag_type in WRITTEN_TAG_TYPES {
            let key = bpm_key(tag_type);
            assert!(
                key.map_key(tag_type).is_some(),
                "{tag_type:?} silently drops {key:?}"
            );
        }
        assert_eq!(bpm_key(TagType::Id3v2).map_key(TagType::Id3v2), Some("TBPM"));
        assert_eq!(
            bpm_key(TagType::Mp4Ilst).map_key(TagType::Mp4Ilst),
            Some("tmpo")
        );
        assert_eq!(
            bpm_key(TagType::VorbisComments).map_key(TagType::VorbisComments),
            Some("BPM")
        );
    }

    #[test]
    fn a_single_hardcoded_bpm_key_would_be_dropped() {
        // This is why bpm_key exists: neither variant works everywhere.
        assert!(ItemKey::IntegerBpm
            .map_key(TagType::VorbisComments)
            .is_none());
        assert!(ItemKey::Bpm.map_key(TagType::Id3v2).is_none());
    }

    #[test]
    fn bpm_keeps_its_decimals_through_a_tag_round_trip() {
        for tag_type in [TagType::Id3v2, TagType::Mp4Ilst, TagType::VorbisComments] {
            let mut tag = Tag::new(tag_type);
            tag.insert_text(bpm_key(tag_type), format_bpm(127.6));
            assert_eq!(
                crate::metadata::read::bpm_of(&tag),
                Some(127.6),
                "the fraction was lost for {tag_type:?}"
            );
        }
    }

    #[test]
    fn format_bpm_is_stable_and_rekordbox_shaped() {
        assert_eq!(format_bpm(128.0), "128.00");
        assert_eq!(format_bpm(127.6), "127.60");
        assert_eq!(format_bpm(174.128), "174.13");
        // Exact halves round to even, because that is what Rust's formatter
        // does and 174.125 is exactly representable in binary. Asserted rather
        // than worked around: the value only has to be *stable*, not to follow
        // school rounding.
        assert_eq!(format_bpm(174.125), "174.12");
        // Writing what we just read must not drift: the second pass has to
        // produce the same text as the first, or every save would nudge the tag.
        let mut tag = Tag::new(TagType::Id3v2);
        let once = format_bpm(127.6);
        tag.insert_text(bpm_key(TagType::Id3v2), once.clone());
        let reread = crate::metadata::read::bpm_of(&tag).expect("read back");
        assert_eq!(format_bpm(reread), once);
    }

    #[test]
    fn bpm_survives_a_generic_tag_round_trip() {
        for tag_type in WRITTEN_TAG_TYPES {
            let mut tag = Tag::new(tag_type);
            tag.insert_text(bpm_key(tag_type), "128".to_string());
            assert_eq!(
                crate::metadata::read::bpm_of(&tag),
                Some(128.0),
                "{tag_type:?} did not round-trip"
            );
        }
    }

    #[test]
    fn clean_trims_and_drops_empty() {
        assert_eq!(clean(&Some("  hi  ".into())), Some("hi".to_string()));
        assert_eq!(clean(&Some("   ".into())), None);
        assert_eq!(clean(&None), None);
    }

    use super::testing::wav_bytes;

    fn picture(kind: PictureType, data: &[u8]) -> Picture {
        Picture::unchecked(data.to_vec())
            .pic_type(kind)
            .mime_type(MimeType::Jpeg)
            .build()
    }

    #[test]
    fn no_cover_strips_every_picture_not_just_the_front_one() {
        // read_cover_bytes falls back to the first picture of any type, so
        // leaving a non-front picture behind would still read as a cover.
        let mut tag = Tag::new(TagType::Id3v2);
        tag.push_picture(picture(PictureType::CoverFront, b"front"));
        tag.push_picture(picture(PictureType::Other, b"other"));

        apply_cover(&mut tag, None, &CoverInput::None);

        assert!(tag.pictures().is_empty());
    }

    #[test]
    fn keeping_the_cover_leaves_the_pictures_alone() {
        let mut tag = Tag::new(TagType::Id3v2);
        tag.push_picture(picture(PictureType::CoverFront, b"front"));

        // Keep resolves to the existing bytes; a failed resolve yields None and
        // must not touch what is already there.
        apply_cover(&mut tag, None, &CoverInput::Keep);

        assert_eq!(tag.pictures().len(), 1);
    }

    #[test]
    fn a_new_cover_replaces_only_the_front_cover() {
        let mut tag = Tag::new(TagType::Id3v2);
        tag.push_picture(picture(PictureType::CoverFront, b"old"));
        tag.push_picture(picture(PictureType::Other, b"other"));

        apply_cover(
            &mut tag,
            Some((b"new".to_vec(), MimeType::Jpeg)),
            &CoverInput::File { path: "cover.jpg".into() },
        );

        assert_eq!(
            tag.get_picture_type(PictureType::CoverFront).unwrap().data(),
            b"new"
        );
        assert_eq!(tag.pictures().len(), 2, "unrelated pictures stay");
    }

    #[test]
    fn no_cover_removes_the_artwork_from_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("track.wav");
        fs::write(&audio, wav_bytes()).unwrap();
        let path = audio.to_string_lossy().to_string();

        // Embed artwork the way a normal write would.
        let mut tagged = read_from_path(&audio).unwrap();
        if tagged.primary_tag().is_none() {
            let tag_type = tagged.file_type().primary_tag_type();
            tagged.insert_tag(Tag::new(tag_type));
        }
        let tag = tagged.primary_tag_mut().unwrap();
        tag.push_picture(picture(PictureType::CoverFront, b"front"));
        tag.save_to_path(&audio, WriteOptions::default()).unwrap();
        assert_eq!(read_cover_bytes(&path).as_deref(), Some(&b"front"[..]));

        // The "no cover" write has to strip it again.
        let mut tagged = read_from_path(&audio).unwrap();
        let tag = tagged.primary_tag_mut().unwrap();
        apply_cover(tag, None, &CoverInput::None);
        tag.save_to_path(&audio, WriteOptions::default()).unwrap();

        assert!(
            read_cover_bytes(&path).is_none(),
            "the cover survived a no-cover write"
        );
    }

    /// Embeds `bytes` as the front cover the way a write does, and returns what
    /// is in the file afterwards.
    fn round_trip_cover(audio: &std::path::Path, image: CoverImage) -> Option<Vec<u8>> {
        let mut tagged = read_from_path(audio).unwrap();
        if tagged.primary_tag().is_none() {
            let tag_type = tagged.file_type().primary_tag_type();
            tagged.insert_tag(Tag::new(tag_type));
        }
        let tag = tagged.primary_tag_mut().unwrap();
        apply_cover(tag, Some(image), &CoverInput::Keep);
        tag.save_to_path(audio, WriteOptions::default()).unwrap();
        read_cover_bytes(&audio.to_string_lossy())
    }

    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 7])
        });
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, image::ImageFormat::Jpeg)
            .unwrap();
        buf.into_inner()
    }

    /// The country reaches the file now, which it did not before 0.9.3.
    ///
    /// `ItemKey::from_key(tag_type, "RELEASECOUNTRY")` resolved to
    /// `ItemKey::Unknown(..)` in lofty 0.22, because the crate had no
    /// `ReleaseCountry` variant — and `insert_text` of an unknown key returns
    /// false and writes nothing. It was never checked, so a country the user
    /// typed lived in the database and the Rekordbox export and nowhere else.
    /// Measured on all five formats the app handles before this was believed.
    ///
    /// The assertion is on the return value as much as on the read-back: a
    /// silent false is what hid this for eight releases.
    #[test]
    fn the_country_is_actually_written() {
        for tag_type in [TagType::Id3v2, TagType::VorbisComments, TagType::Mp4Ilst] {
            let mut tag = Tag::new(tag_type);
            assert!(
                tag.insert_text(ItemKey::ReleaseCountry, "DE".to_string()),
                "{tag_type:?} refused the country"
            );
            assert_eq!(tag.get_string(ItemKey::ReleaseCountry), Some("DE"));
        }
    }

    /// A canary for an upstream bug, not a rule of ours.
    ///
    /// lofty 0.25.2's `id3/v2/write/chunk_file.rs:105` subtracts where it should
    /// add when a new ID3v2 chunk is larger than a RIFF file's whole audio
    /// stream, and the subtraction underflows. Unreachable with real audio — a
    /// cover is never bigger than its track, and a 300 KB cover into the 5 MB
    /// `plain.wav` fixture was checked to come out intact — but it is reachable
    /// with a fixture of a few dozen samples, which is why `wav_bytes` carries
    /// a second of silence.
    ///
    /// When lofty fixes it this test fails, and that is the point: the fixture
    /// can shrink again and this can go.
    #[test]
    #[should_panic(expected = "attempt to subtract with overflow")]
    fn a_cover_larger_than_the_audio_still_panics_upstream() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("tiny.wav");
        // Deliberately the old fixture size: a handful of samples.
        fs::write(&audio, super::testing::tiny_wav()).unwrap();

        // Twice, and that matters: the arithmetic is in the branch that
        // *rewrites* an existing ID3v2 chunk. A first write appends and is
        // fine, which is why the app's own suite only ever hit this on the
        // second cover of an undo round-trip.
        let mut tag = Tag::new(TagType::Id3v2);
        tag.insert_text(ItemKey::TrackTitle, "t".to_string());
        tag.save_to_path(&audio, WriteOptions::default()).unwrap();

        let mut tagged = lofty::read_from_path(&audio).unwrap();
        let tag = tagged.primary_tag_mut().unwrap();
        tag.push_picture(
            Picture::unchecked(vec![0u8; 64 * 1024])
                .pic_type(PictureType::CoverFront)
                .mime_type(MimeType::Jpeg)
                .build(),
        );
        let _ = tag.save_to_path(&audio, WriteOptions::default());
    }

    #[test]
    fn an_undo_puts_the_original_bytes_back() {
        // The claim undo makes, and the only one that matters here: not a
        // picture that looks the same, the same file (C8). The original is
        // deliberately *not* CDJ-shaped — it is whatever the user's file held.
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("track.wav");
        fs::write(&audio, wav_bytes()).unwrap();

        let original = jpeg(1400, 1400);
        let embedded = round_trip_cover(&audio, prepare_cover(original.clone(), true).unwrap());
        assert_eq!(embedded.as_deref(), Some(&original[..]));

        // A write replaces it, re-encoding as it should for a new cover.
        let replacement = jpeg(1000, 1000);
        let after_write =
            round_trip_cover(&audio, prepare_cover(replacement.clone(), false).unwrap()).unwrap();
        assert_ne!(after_write, replacement, "a new cover is CDJ-shaped");

        // The undo hands back the bytes it captured before that write.
        let restored = round_trip_cover(&audio, prepare_cover(original.clone(), true).unwrap());
        assert_eq!(
            restored.as_deref(),
            Some(&original[..]),
            "undo returned a re-encoded likeness instead of the file's cover"
        );
    }

    #[test]
    fn a_restored_png_stays_a_png_and_says_so() {
        // What a file held before a write is not necessarily a JPEG, and a
        // picture labelled as one it is not would be a cover players refuse.
        let png = {
            let img = image::RgbImage::from_fn(8, 8, |_, _| image::Rgb([1, 2, 3]));
            let mut buf = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(img)
                .write_to(&mut buf, image::ImageFormat::Png)
                .unwrap();
            buf.into_inner()
        };
        let (bytes, mime) = prepare_cover(png.clone(), true).unwrap();
        assert_eq!(bytes, png);
        assert_eq!(mime, MimeType::Png);

        // Without the verbatim flag the same PNG is converted, which is what
        // "CDJ-shaped" means for an ordinary write.
        let (converted, mime) = prepare_cover(png, false).unwrap();
        assert_eq!(mime, MimeType::Jpeg);
        assert!(converted.starts_with(&[0xFF, 0xD8]));
    }

    #[test]
    fn an_ordinary_write_stops_re_encoding_a_cover_that_is_already_right() {
        // `Keep` resolves to the cover already in the file, and every write used
        // to send it through the encoder again — the same picture, one
        // generation worse, on every edit.
        let shaped = artwork::process_cover(&jpeg(1200, 1200)).unwrap();
        let (once, _) = prepare_cover(shaped.clone(), false).unwrap();
        assert_eq!(once, shaped, "an already CDJ-shaped cover was re-encoded");

        // And an oversized one still is.
        let big = jpeg(1200, 1200);
        let (processed, _) = prepare_cover(big.clone(), false).unwrap();
        assert_ne!(processed, big);
    }

    #[test]
    fn verbatim_falls_back_to_the_encoder_for_bytes_it_cannot_name() {
        // Better a re-encoded cover than a picture embedded under a mime type
        // that was guessed. Undecodable bytes then fail the write, which is the
        // honest outcome — there is no image here.
        assert!(prepare_cover(b"not an image".to_vec(), true).is_err());
    }

    #[test]
    fn sidecar_prefers_known_cover_name() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("track.aiff");
        fs::write(&audio, b"not really audio").unwrap();
        fs::write(dir.path().join("aaa.png"), b"other-image").unwrap();
        fs::write(dir.path().join("cover.jpg"), b"the-cover").unwrap();

        let src = audio.to_string_lossy().to_string();
        assert!(has_sidecar_cover(&src));
        assert_eq!(find_sidecar_cover(&src).as_deref(), Some(&b"the-cover"[..]));
    }

    #[test]
    fn sidecar_falls_back_to_first_image() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("track.wav");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("zzz.png"), b"only-image").unwrap();

        let src = audio.to_string_lossy().to_string();
        assert_eq!(find_sidecar_cover(&src).as_deref(), Some(&b"only-image"[..]));
    }

    #[test]
    fn sidecar_none_when_no_image() {
        let dir = tempfile::tempdir().unwrap();
        let audio = dir.path().join("track.flac");
        fs::write(&audio, b"x").unwrap();
        fs::write(dir.path().join("notes.txt"), b"hello").unwrap();

        let src = audio.to_string_lossy().to_string();
        assert!(!has_sidecar_cover(&src));
        assert!(find_sidecar_cover(&src).is_none());
    }
}
