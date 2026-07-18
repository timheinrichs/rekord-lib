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

/// Bekannte Cover-Dateinamen (ohne Endung) und Bild-Endungen für Sidecar-Cover.
const COVER_NAMES: &[&str] = &["cover", "folder", "front", "album", "artwork", "art", "albumart"];
const COVER_EXTS: &[&str] = &["jpg", "jpeg", "png", "webp"];

/// Sucht ein Cover-Bild im selben Ordner wie die Audiodatei (z. B. cover.jpg).
/// Viele Sammlungen legen das Album-Cover als separate Datei ab statt es
/// einzubetten.
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
    // Bevorzugt bekannte Cover-Dateinamen, sonst das erste Bild im Ordner.
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

/// Eingebettetes Cover, sonst ein Cover-Bild aus dem Ordner.
pub fn read_cover_or_sidecar(source: &str) -> Option<Vec<u8>> {
    read_cover_bytes(source).or_else(|| find_sidecar_cover(source))
}

/// Prüft günstig (ohne Datei zu lesen), ob im Ordner ein Cover-Bild liegt.
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

/// Ermittelt die Cover-Bytes gemäß gewählter Quelle (noch unverarbeitet).
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
