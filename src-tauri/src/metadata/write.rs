use lofty::config::WriteOptions;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::{ItemKey, Tag, TagExt};

use crate::error::{AppError, AppResult};
use crate::metadata::{artwork, net};
use crate::models::{CoverInput, TrackMetadata};

/// Liest das eingebettete Front-Cover (oder das erste Bild) einer Datei.
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

/// Ermittelt die Cover-Bytes gemäß gewählter Quelle (noch unverarbeitet).
pub async fn resolve_cover(source: &str, cover: &CoverInput) -> AppResult<Option<Vec<u8>>> {
    match cover {
        CoverInput::None => Ok(None),
        CoverInput::Keep => Ok(read_cover_bytes(source)),
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

/// Schreibt bestätigte Metadaten und/oder Cover in die (bereits konvertierte)
/// Ausgabedatei. `metadata = None` lässt die Texttags unangetastet; das Cover
/// wird dennoch gemäß `cover` gesetzt (Default: vorhandenes Cover erhalten).
pub async fn finalize(
    output: &str,
    source: &str,
    metadata: &Option<TrackMetadata>,
    cover: &CoverInput,
) -> AppResult<()> {
    // 1. Cover beschaffen und CDJ-tauglich aufbereiten.
    let cover_jpeg = match resolve_cover(source, cover).await? {
        Some(bytes) => Some(artwork::process_cover(&bytes)?),
        None => None,
    };

    // Nichts zu tun, wenn weder Metadaten noch Cover geschrieben werden.
    if metadata.is_none() && cover_jpeg.is_none() && !matches!(cover, CoverInput::None) {
        // Kein Cover gefunden und keine Metadaten -> nichts zu schreiben.
        return Ok(());
    }

    // 2. Tags öffnen (ggf. neuen Tag im passenden Format anlegen).
    let mut tagged =
        read_from_path(output).map_err(|e| AppError::Metadata(e.to_string()))?;
    if tagged.primary_tag().is_none() {
        let tag_type = tagged.file_type().primary_tag_type();
        tagged.insert_tag(Tag::new(tag_type));
    }
    let tag = tagged
        .primary_tag_mut()
        .ok_or_else(|| AppError::Metadata("kein beschreibbarer Tag".into()))?;

    // 3. Textfelder setzen (nur wenn bestätigt).
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

    // 4. Cover einbetten (bestehendes Front-Cover ersetzen).
    if let Some(bytes) = cover_jpeg {
        tag.remove_picture_type(PictureType::CoverFront);
        tag.push_picture(Picture::new_unchecked(
            PictureType::CoverFront,
            Some(MimeType::Jpeg),
            None,
            bytes,
        ));
    }

    // 5. Speichern.
    tag.save_to_path(output, WriteOptions::default())
        .map_err(|e| AppError::Metadata(format!("Tags konnten nicht geschrieben werden: {e}")))?;

    Ok(())
}

fn clean(v: &Option<String>) -> Option<String> {
    v.as_ref()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
