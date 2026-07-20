use image::{ExtendedColorType, ImageEncoder};

use crate::error::{AppError, AppResult};

/// Maximum edge length (px) for an embedded cover (CDJ recommendation: <= 800).
const MAX_EDGE: u32 = 800;
/// Target size in bytes (CDJ recommendation: < 100 KB).
const TARGET_BYTES: usize = 100_000;

/// Turns arbitrary image bytes into a CDJ-friendly JPEG:
/// longest edge <= 800 px, file size ideally < 100 KB.
pub fn process_cover(bytes: &[u8]) -> AppResult<Vec<u8>> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| AppError::Metadata(format!("Could not read cover: {e}")))?;

    let (w, h) = (img.width(), img.height());
    let resized = if w.max(h) > MAX_EDGE {
        // resize fits the image into the box while keeping the aspect ratio.
        img.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    let rgb = resized.to_rgb8();
    let (rw, rh) = (rgb.width(), rgb.height());

    // Lower the quality step by step until the target size is reached.
    let mut quality: u8 = 90;
    loop {
        let mut buf = Vec::new();
        let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, quality);
        encoder
            .write_image(rgb.as_raw(), rw, rh, ExtendedColorType::Rgb8)
            .map_err(|e| AppError::Metadata(format!("JPEG encoding failed: {e}")))?;

        if buf.len() <= TARGET_BYTES || quality <= 40 {
            return Ok(buf);
        }
        quality -= 10;
    }
}

/// Creates a small square JPEG thumbnail (longest edge `edge` px)
/// for display in the track list. Much smaller than [`process_cover`].
pub fn thumbnail(bytes: &[u8], edge: u32) -> AppResult<Vec<u8>> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| AppError::Metadata(format!("Could not read cover: {e}")))?;

    let resized = img.resize(edge, edge, image::imageops::FilterType::Triangle);
    let rgb = resized.to_rgb8();
    let (rw, rh) = (rgb.width(), rgb.height());

    let mut buf = Vec::new();
    let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 80);
    encoder
        .write_image(rgb.as_raw(), rw, rh, ExtendedColorType::Rgb8)
        .map_err(|e| AppError::Metadata(format!("JPEG encoding failed: {e}")))?;
    Ok(buf)
}

/// Fetches the front cover of a MusicBrainz release from the Cover Art Archive.
pub async fn fetch_musicbrainz_cover(
    client: &reqwest::Client,
    release_id: &str,
) -> AppResult<Vec<u8>> {
    // "front-500" returns a ~500px variant; enough for the <=800px target.
    let url = format!("https://coverartarchive.org/release/{release_id}/front-500");
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| AppError::Metadata(format!("Cover fetch failed: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Metadata(format!(
            "No cover found (HTTP {})",
            resp.status()
        )));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Metadata(e.to_string()))?;
    Ok(bytes.to_vec())
}
