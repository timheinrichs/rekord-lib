use image::{ExtendedColorType, ImageEncoder};

use crate::error::{AppError, AppResult};

/// Maximale Kantenlänge (px) für eingebettetes Cover (CDJ-Empfehlung: ≤ 800).
const MAX_EDGE: u32 = 800;
/// Zielgröße in Bytes (CDJ-Empfehlung: < 100 KB).
const TARGET_BYTES: usize = 100_000;

/// Bringt beliebige Bild-Bytes auf ein CDJ-taugliches JPEG:
/// längste Kante ≤ 800 px, Dateigröße möglichst < 100 KB.
pub fn process_cover(bytes: &[u8]) -> AppResult<Vec<u8>> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| AppError::Metadata(format!("Cover konnte nicht gelesen werden: {e}")))?;

    let (w, h) = (img.width(), img.height());
    let resized = if w.max(h) > MAX_EDGE {
        // resize passt das Bild unter Beibehaltung des Seitenverhältnisses in die Box.
        img.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    let rgb = resized.to_rgb8();
    let (rw, rh) = (rgb.width(), rgb.height());

    // Qualität schrittweise senken, bis die Zielgröße erreicht ist.
    let mut quality: u8 = 90;
    loop {
        let mut buf = Vec::new();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
        encoder
            .write_image(rgb.as_raw(), rw, rh, ExtendedColorType::Rgb8)
            .map_err(|e| AppError::Metadata(format!("JPEG-Encoding fehlgeschlagen: {e}")))?;

        if buf.len() <= TARGET_BYTES || quality <= 40 {
            return Ok(buf);
        }
        quality -= 10;
    }
}

/// Erzeugt ein kleines quadratisches JPEG-Thumbnail (längste Kante `edge` px)
/// für die Anzeige in der Track-Liste. Deutlich kleiner als [`process_cover`].
pub fn thumbnail(bytes: &[u8], edge: u32) -> AppResult<Vec<u8>> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| AppError::Metadata(format!("Cover konnte nicht gelesen werden: {e}")))?;

    let resized = img.resize(edge, edge, image::imageops::FilterType::Triangle);
    let rgb = resized.to_rgb8();
    let (rw, rh) = (rgb.width(), rgb.height());

    let mut buf = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80);
    encoder
        .write_image(rgb.as_raw(), rw, rh, ExtendedColorType::Rgb8)
        .map_err(|e| AppError::Metadata(format!("JPEG-Encoding fehlgeschlagen: {e}")))?;
    Ok(buf)
}

/// Lädt das Front-Cover einer MusicBrainz-Release von der Cover Art Archive.
pub async fn fetch_musicbrainz_cover(
    client: &reqwest::Client,
    release_id: &str,
) -> AppResult<Vec<u8>> {
    // "front-500" liefert eine ~500px-Variante; ausreichend für ≤800px-Ziel.
    let url = format!("https://coverartarchive.org/release/{release_id}/front-500");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Metadata(format!("Cover-Abruf fehlgeschlagen: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Metadata(format!(
            "Kein Cover gefunden (HTTP {})",
            resp.status()
        )));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Metadata(e.to_string()))?;
    Ok(bytes.to_vec())
}
