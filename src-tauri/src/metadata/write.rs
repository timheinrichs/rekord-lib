use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::{ItemKey, Tag, TagExt};

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
        CoverInput::Musicbrainz { release_id } => {
            let client = net::client()?;
            let bytes = artwork::fetch_musicbrainz_cover(&client, release_id).await?;
            Ok(Some(bytes))
        }
    }
}

/// Writes confirmed metadata and/or cover into the (already converted) output
/// file. `metadata = None` leaves the text tags untouched; the cover is still
/// set according to `cover` (default: keep the existing cover).
pub async fn finalize(
    output: &str,
    source: &str,
    metadata: &Option<TrackMetadata>,
    cover: &CoverInput,
) -> AppResult<()> {
    // 1. Obtain the cover and prepare it for CDJ.
    let cover_jpeg = match resolve_cover(source, cover).await? {
        Some(bytes) => Some(artwork::process_cover(&bytes)?),
        None => None,
    };

    // Nothing to do if neither metadata nor cover is written.
    if metadata.is_none() && cover_jpeg.is_none() && !matches!(cover, CoverInput::None) {
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

    // 3. Set text fields (only if confirmed).
    if let Some(md) = metadata {
        if let Some(v) = clean(&md.title) {
            tag.set_title(v);
        }
        if let Some(v) = clean(&md.artist) {
            tag.set_artist(v);
        }
        if let Some(v) = clean(&md.album) {
            tag.set_album(v);
        }
        if let Some(v) = clean(&md.genre) {
            tag.set_genre(v);
        }
        if let Some(v) = clean(&md.album_artist) {
            tag.insert_text(ItemKey::AlbumArtist, v);
        }
        if let Some(y) = md.year.as_ref().and_then(|s| s.trim().parse::<u32>().ok()) {
            tag.set_year(y);
        }
        if let Some(n) = md.track_number {
            tag.set_track(n);
        }
    }

    // 4. Embed cover (replace the existing front cover).
    if let Some(bytes) = cover_jpeg {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Jpeg),
            None,
            bytes,
        ));
    }

    // 5. Save.
    tag.save_to_path(output, WriteOptions::default())
        .map_err(|e| AppError::Metadata(format!("Failed to write tags: {e}")))?;

    Ok(())
}

fn clean(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
