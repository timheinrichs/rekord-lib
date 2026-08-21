use image::{ExtendedColorType, ImageEncoder};

use crate::error::{AppError, AppResult};

/// Maximum edge length (px) for an embedded cover (CDJ recommendation: <= 800).
const MAX_EDGE: u32 = 800;
/// Target size in bytes (CDJ recommendation: < 100 KB).
const TARGET_BYTES: usize = 100_000;

/// Are these bytes already what `process_cover` would produce?
///
/// A cover this app embedded once is CDJ-shaped already, and every tag write
/// used to send it through the encoder again — the same picture, one generation
/// worse, for nothing. Judged from the JPEG header rather than a decode: the
/// dimensions are in it, and the point is to be cheaper than the re-encode it
/// avoids.
///
/// Deliberately narrow, because a false yes is not a wasted encode but a cover
/// a player may refuse to draw:
///
/// - **baseline or extended sequential only** (`SOF0`/`SOF1`). A progressive
///   JPEG is small, common, and exactly what CDJs fail to render — normalising
///   it is half of why the encoder exists.
/// - **1 or 3 components**, so a CMYK/Adobe JPEG still goes through the encoder
///   and comes back RGB.
/// - **ends in an end-of-image marker**, which a truncated download does not.
///   The decode this replaces failed on those; without the check the broken
///   bytes would be embedded and only show up later as an unreadable thumbnail.
/// - **a PNG answers no** even when it is small: converting it is part of what
///   CDJ-shaped means here.
pub fn already_cdj_shaped(bytes: &[u8]) -> bool {
    if bytes.len() > TARGET_BYTES
        || !bytes.starts_with(&[0xFF, 0xD8])
        || !bytes.ends_with(&[0xFF, 0xD9])
    {
        return false;
    }
    match jpeg_frame(bytes) {
        Some(frame) => {
            matches!(frame.marker, 0xC0 | 0xC1)
                && matches!(frame.components, 1 | 3)
                && frame.width.max(frame.height) <= MAX_EDGE
        }
        None => false,
    }
}

/// What a JPEG's frame header says about the image.
struct JpegFrame {
    /// The `SOFn` marker itself — the encoding, which matters as much as the size.
    marker: u8,
    width: u32,
    height: u32,
    components: u8,
}

/// Reads the first frame header, without decoding the image.
///
/// Walks the marker segments looking for a start-of-frame. Returns `None` for
/// anything that does not parse cleanly — the caller treats that as "not ours",
/// which is the safe direction.
fn jpeg_frame(bytes: &[u8]) -> Option<JpegFrame> {
    let mut i = 2; // past the SOI we already checked
    while i + 3 < bytes.len() {
        if bytes[i] != 0xFF {
            return None;
        }
        let marker = bytes[i + 1];
        match marker {
            // Fill bytes between segments.
            0xFF => {
                i += 1;
                continue;
            }
            // The standalone markers: TEM, the restart markers, SOI and EOI.
            // They carry no length field, and reading one where a real decoder
            // reads none is how a parser ends up walking a different file than
            // the decoder does — far enough into an `APPn` or comment payload to
            // find a frame header somebody put there.
            0x01 | 0xD0..=0xD9 => {
                i += 2;
                continue;
            }
            // A stuffed zero is not a marker at all, and 0x02..=0xBF are
            // reserved. Either means this is not a file worth guessing about.
            0x00 | 0x02..=0xBF => return None,
            _ => {}
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if len < 2 {
            return None;
        }
        // Every `SOFn` except the three that are not frames: 0xC4 huffman
        // tables, 0xC8 the JPG extension, 0xCC arithmetic coding conditioning.
        let is_frame = matches!(marker, 0xC0..=0xCF) && !matches!(marker, 0xC4 | 0xC8 | 0xCC);
        if is_frame {
            let seg = bytes.get(i + 4..i + 4 + 6)?;
            let components = seg[5];
            // A frame header is its own 8 bytes plus 3 per component. A length
            // that disagrees means this is not the frame it claims to be.
            if len != 8 + 3 * components as usize {
                return None;
            }
            return Some(JpegFrame {
                marker,
                height: u16::from_be_bytes([seg[1], seg[2]]) as u32,
                width: u16::from_be_bytes([seg[3], seg[4]]) as u32,
                components,
            });
        }
        // The entropy-coded data starts here, so there was no frame header
        // before it and this is not a file we can answer for.
        if marker == 0xDA {
            return None;
        }
        i += 2 + len;
    }
    None
}

/// The smallest edge the fallback below will shrink to. Past this a cover is
/// visibly soft on a player's screen, and a picture nobody can read is not an
/// improvement over a file that is slightly too large.
const MIN_EDGE: u32 = 320;

/// Turns arbitrary image bytes into a CDJ-friendly JPEG: longest edge
/// <= [`MAX_EDGE`], file size <= [`TARGET_BYTES`].
///
/// Both limits are kept, not just aimed at. Quality comes down first, because a
/// smaller picture is the more visible loss; only when quality has bottomed out
/// does the edge shrink. The output being *inside* the budget is what lets
/// [`already_cdj_shaped`] recognise it later — a result that stayed over the
/// budget would be re-encoded by every subsequent write, which is the
/// generation loss this pair exists to stop.
pub fn process_cover(bytes: &[u8]) -> AppResult<Vec<u8>> {
    let img = image::load_from_memory(bytes)
        .map_err(|e| AppError::Metadata(format!("Could not read cover: {e}")))?;

    let (w, h) = (img.width(), img.height());
    let mut edge = MAX_EDGE;
    let mut resized = if w.max(h) > MAX_EDGE {
        // resize fits the image into the box while keeping the aspect ratio.
        img.resize(MAX_EDGE, MAX_EDGE, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    loop {
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

            if buf.len() <= TARGET_BYTES {
                return Ok(buf);
            }
            if quality <= 40 {
                break;
            }
            quality -= 10;
        }

        // Quality alone did not get there. Shrink and try again — a rare path,
        // reached only by a busy photograph that stays over 100 KB at 800 px.
        if edge <= MIN_EDGE {
            // As small and as compressed as we are willing to go. Better a
            // slightly heavy cover than none, and the caller gets a picture.
            let mut buf = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 40)
                .write_image(rgb.as_raw(), rw, rh, ExtendedColorType::Rgb8)
                .map_err(|e| AppError::Metadata(format!("JPEG encoding failed: {e}")))?;
            return Ok(buf);
        }
        edge = (edge * 3 / 4).max(MIN_EDGE);
        resized = resized.resize(edge, edge, image::imageops::FilterType::Lanczos3);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A JPEG of the given size, encoded the way anything else would encode it.
    fn jpeg(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 256) as u8, (y % 256) as u8, 128])
        });
        let mut buf = Vec::new();
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut buf, 90)
            .write_image(img.as_raw(), w, h, ExtendedColorType::Rgb8)
            .unwrap();
        buf
    }

    fn png(w: u32, h: u32) -> Vec<u8> {
        let img = image::RgbImage::from_fn(w, h, |_, _| image::Rgb([10, 20, 30]));
        let mut buf = std::io::Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut buf, image::ImageFormat::Png)
            .unwrap();
        buf.into_inner()
    }

    #[test]
    fn process_cover_produces_something_it_then_recognises() {
        // The round trip is the claim: what the encoder makes must not be sent
        // through the encoder again on the next write.
        let out = process_cover(&jpeg(1200, 900)).unwrap();
        assert!(out.starts_with(&[0xFF, 0xD8]), "not a JPEG");
        assert!(out.len() <= TARGET_BYTES);
        assert_eq!(jpeg_frame(&out).map(|f| f.width), Some(MAX_EDGE));
        assert!(already_cdj_shaped(&out));
    }

    #[test]
    fn already_cdj_shaped_says_no_to_what_still_needs_work() {
        // Too large on its longest edge, even though the file is small.
        assert!(!already_cdj_shaped(&jpeg(MAX_EDGE + 1, 100)));
        assert!(!already_cdj_shaped(&jpeg(100, MAX_EDGE + 1)));

        // Small enough on screen, too big as a file. Trailing bytes after the
        // end marker keep it a valid JPEG and make the point without needing an
        // image that really encodes to 100 KB.
        let mut heavy = jpeg(100, 100);
        heavy.resize(TARGET_BYTES + 1, 0);
        assert!(!already_cdj_shaped(&heavy));

        // A PNG is not CDJ-shaped here even when it is small: turning it into a
        // JPEG is part of what the encoder is for.
        assert!(!already_cdj_shaped(&png(64, 64)));
    }

    #[test]
    fn already_cdj_shaped_survives_bytes_that_are_not_an_image() {
        // Anything unreadable answers "no" and takes the ordinary path, rather
        // than being embedded on a guess.
        assert!(!already_cdj_shaped(b""));
        assert!(!already_cdj_shaped(b"ID3 this is audio"));
        assert!(!already_cdj_shaped(&[0xFF, 0xD8]));
        // A truncated JPEG: the header says start-of-image and then stops.
        let truncated = &jpeg(64, 64)[..8];
        assert!(!already_cdj_shaped(truncated));
    }

    #[test]
    fn jpeg_frame_reads_the_header_without_decoding() {
        let frame = jpeg_frame(&jpeg(321, 123)).unwrap();
        assert_eq!((frame.width, frame.height), (321, 123));
        assert_eq!(frame.components, 3);
        assert_eq!(frame.marker, 0xC0, "the encoder writes a baseline frame");
        assert!(jpeg_frame(&png(10, 10)).is_none());
    }

    #[test]
    fn already_cdj_shaped_refuses_an_encoding_a_player_may_not_draw() {
        // A progressive JPEG is small and common, and a CDJ will not render it.
        // Normalising that is half of what the encoder is for, so the fast path
        // must not wave it through.
        let mut progressive = jpeg(200, 200);
        let sof = progressive
            .windows(2)
            .position(|w| w == [0xFF, 0xC0])
            .expect("the fixture is baseline");
        progressive[sof + 1] = 0xC2; // SOF2 — progressive
        assert!(!already_cdj_shaped(&progressive));

        // Four components is CMYK/Adobe, which used to come back as RGB.
        let mut cmyk = jpeg(200, 200);
        let sof = cmyk.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
        cmyk[sof + 9] = 4;
        assert!(!already_cdj_shaped(&cmyk));
    }

    #[test]
    fn jpeg_frame_walks_the_file_the_way_a_decoder_does() {
        // Two ways a parser can end up reading a different file than the
        // decoder reads, and both would let a progressive JPEG through as
        // baseline: treating a standalone marker as if it had a length, and
        // trusting a frame header whose length does not fit its components.
        let mut with_tem = jpeg(64, 64);
        with_tem.splice(2..2, [0xFF, 0x01]); // TEM, which carries no length
        let frame = jpeg_frame(&with_tem).expect("TEM must not derail the walk");
        assert_eq!((frame.width, frame.height), (64, 64));

        let mut bad_len = jpeg(64, 64);
        let sof = bad_len.windows(2).position(|w| w == [0xFF, 0xC0]).unwrap();
        bad_len[sof + 3] = 0x30; // a length no frame header has
        assert!(jpeg_frame(&bad_len).is_none());

        // A reserved marker is not something to guess about either.
        let mut reserved = jpeg(64, 64);
        reserved.splice(2..2, [0xFF, 0x02]);
        assert!(jpeg_frame(&reserved).is_none());
    }

    #[test]
    fn already_cdj_shaped_refuses_a_truncated_download() {
        // The decode this replaced failed on a half-written file. Without the
        // end-of-image check the broken bytes would be embedded as the cover and
        // only show up later as a thumbnail that will not load.
        let whole = process_cover(&jpeg(400, 400)).unwrap();
        assert!(already_cdj_shaped(&whole));

        let cut = &whole[..whole.len() - 64];
        assert!(!already_cdj_shaped(cut));
    }

    #[test]
    fn process_cover_keeps_the_budget_it_promises() {
        // A busy photograph is the case where quality alone does not get under
        // 100 KB. Whatever comes out has to be inside both limits, or the next
        // write re-encodes it and the generation loss is back.
        let noisy = {
            let img = image::RgbImage::from_fn(1600, 1600, |x, y| {
                let n = (x * 7 + y * 13) as u8;
                image::Rgb([n.wrapping_mul(31), n.wrapping_mul(17), n.wrapping_mul(101)])
            });
            let mut buf = std::io::Cursor::new(Vec::new());
            image::DynamicImage::ImageRgb8(img)
                .write_to(&mut buf, image::ImageFormat::Jpeg)
                .unwrap();
            buf.into_inner()
        };
        let out = process_cover(&noisy).unwrap();
        assert!(out.len() <= TARGET_BYTES, "{} bytes", out.len());
        assert!(already_cdj_shaped(&out), "its own output was not recognised");
    }
}
