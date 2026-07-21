use std::io::Cursor;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

use crate::bandcamp::session::Session;
use crate::error::{AppError, AppResult};
use crate::metadata::net;

/// Progress of a Bandcamp download (streamed to the frontend).
#[derive(Clone, Serialize)]
struct BandcampProgress {
    key: String,
    downloaded: u64,
    total: u64,
    stage: String,
}

fn emit_progress(app: &AppHandle, key: &str, downloaded: u64, total: u64, stage: &str) {
    let _ = app.emit(
        "bandcamp://progress",
        BandcampProgress {
            key: key.to_string(),
            downloaded,
            total,
            stage: stage.to_string(),
        },
    );
}

/// Reads the response body as a stream into a Vec and reports progress
/// (throttled, ~every 256 KB).
async fn stream_collect(
    mut resp: reqwest::Response,
    app: &AppHandle,
    key: &str,
    stage: &str,
) -> AppResult<Vec<u8>> {
    let total = resp.content_length().unwrap_or(0);
    let mut buf: Vec<u8> = Vec::with_capacity(total.min(64 * 1024 * 1024) as usize);
    let mut last_emit: u64 = 0;
    emit_progress(app, key, 0, total, stage);
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::Bandcamp(format!("Download stream: {e}")))?
    {
        buf.extend_from_slice(&chunk);
        let dl = buf.len() as u64;
        if dl - last_emit >= 256 * 1024 {
            last_emit = dl;
            emit_progress(app, key, dl, total, stage);
        }
    }
    emit_progress(app, key, buf.len() as u64, total, stage);
    Ok(buf)
}

/// Preferred download formats (lossless first); the result is converted to the
/// CDJ target format afterward anyway.
const FORMAT_PREFERENCE: [&str; 4] = ["flac", "aiff-lossless", "wav", "mp3-320"];

/// Audio extensions taken from an album ZIP.
const AUDIO_EXTS: [&str; 7] = ["flac", "aiff", "aif", "wav", "mp3", "m4a", "aac"];

/// Downloads a purchased item and returns the (possibly extracted) file paths.
pub async fn download(
    app: &AppHandle,
    session: &Session,
    key: &str,
    page_url: &str,
    dest_dir: &str,
    preferred_format: Option<&str>,
) -> AppResult<Vec<String>> {
    // Dedicated client without an overall timeout (albums can be large).
    let client = net::download_client()?;

    // 1. Load the download page and extract the data-blob.
    let html = client
        .get(page_url)
        .header("Cookie", &session.cookie_header)
        .send()
        .await
        .map_err(|e| AppError::Bandcamp(format!("Download page: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::Bandcamp(e.to_string()))?;

    let blob = extract_blob(&html)?;

    // 2. Pick the first digital item + a suitable format.
    let item = blob
        .get("digital_items")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or_else(|| AppError::Bandcamp("no digital_items on the download page".into()))?;

    let downloads = item
        .get("downloads")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::Bandcamp("no downloads in the item".into()))?;

    // Try the user's preferred format first, then the lossless-first fallback.
    let mut prefs: Vec<&str> = Vec::new();
    if let Some(p) = preferred_format.filter(|p| !p.is_empty()) {
        prefs.push(p);
    }
    for f in FORMAT_PREFERENCE {
        if !prefs.contains(&f) {
            prefs.push(f);
        }
    }
    let (fmt, url) = prefs
        .iter()
        .find_map(|f| {
            downloads
                .get(*f)
                .and_then(|d| d.get("url"))
                .and_then(Value::as_str)
                .map(|u| (*f, u.to_string()))
        })
        .ok_or_else(|| {
            AppError::Bandcamp(format!(
                "no supported format available (present: {:?})",
                downloads.keys().collect::<Vec<_>>()
            ))
        })?;

    let title = item
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("bandcamp");
    let is_album = item
        .get("download_type")
        .and_then(Value::as_str)
        .map(|t| t == "a")
        .unwrap_or(false);

    // 3+4. Fetch the file bytes (the .vrs=1 request returns the file either
    // directly or as JSON with the real download_url) – streamed with progress.
    let bytes = fetch_download_bytes(&client, session, key, &url, app).await?;

    std::fs::create_dir_all(dest_dir)?;
    let safe_title = sanitize(title);

    // 5. Extract album ZIP, save a single track directly.
    let done = bytes.len() as u64;
    if is_album || looks_like_zip(&bytes) {
        emit_progress(app, key, done, done, "Extracting");
        extract_zip(&bytes, Path::new(dest_dir), &safe_title)
    } else {
        emit_progress(app, key, done, done, "Saving");
        let ext = extension_for_format(fmt);
        let out = Path::new(dest_dir).join(format!("{safe_title}.{ext}"));
        std::fs::write(&out, &bytes)?;
        Ok(vec![out.to_string_lossy().to_string()])
    }
}

/// Extracts and decodes the `data-blob` JSON from the download page.
fn extract_blob(html: &str) -> AppResult<Value> {
    let marker = "data-blob=\"";
    let start = html
        .find(marker)
        .ok_or_else(|| AppError::Bandcamp("data-blob not found".into()))?
        + marker.len();
    let rest = &html[start..];
    let end = rest
        .find('"')
        .ok_or_else(|| AppError::Bandcamp("data-blob not closed".into()))?;
    let escaped = &rest[..end];
    let json = html_unescape(escaped);
    serde_json::from_str(&json)
        .map_err(|e| AppError::Bandcamp(format!("data-blob JSON error: {e}")))
}

/// Fetches the file bytes for a format download link. The `.vrs=1` request
/// returns either the file directly (ZIP/audio) or JSON with the real URL.
async fn fetch_download_bytes(
    client: &reqwest::Client,
    session: &Session,
    key: &str,
    url: &str,
    app: &AppHandle,
) -> AppResult<Vec<u8>> {
    let probe_url = if url.contains('?') {
        format!("{url}&.vrs=1")
    } else {
        format!("{url}?.vrs=1")
    };

    let resp = client
        .get(&probe_url)
        .header("Cookie", &session.cookie_header)
        .header(reqwest::header::ACCEPT, "application/json, text/javascript, */*")
        .send()
        .await
        .map_err(|e| AppError::Bandcamp(format!("statdownload: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Bandcamp(format!("statdownload HTTP {status}")));
    }
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // Read the body as a stream (for a direct file this is already the large download).
    let bytes = stream_collect(resp, app, key, "Downloading").await?;

    // A file directly (ZIP/audio)? Then use the bytes immediately.
    let is_json = ct.contains("json") || bytes.first() == Some(&b'{');
    if !is_json {
        return Ok(bytes);
    }

    // JSON variant: extract the real download_url and stream the file.
    let json: Value = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::Bandcamp(format!("statdownload JSON: {e}")))?;
    let dl = json
        .get("download_url")
        .or_else(|| json.get("url"))
        .or_else(|| json.get("retry_url"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::Bandcamp(format!(
                "no download_url in statdownload JSON (keys: {:?})",
                json.as_object().map(|o| o.keys().collect::<Vec<_>>())
            ))
        })?;

    let file_resp = client
        .get(dl)
        .header("Cookie", &session.cookie_header)
        .send()
        .await
        .map_err(|e| AppError::Bandcamp(format!("File download: {e}")))?;
    let status = file_resp.status();
    if !status.is_success() {
        return Err(AppError::Bandcamp(format!("File download HTTP {status}")));
    }
    stream_collect(file_resp, app, key, "Downloading").await
}

fn looks_like_zip(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && &bytes[..2] == b"PK"
}

/// Extracts audio files from an album ZIP into a subfolder.
fn extract_zip(bytes: &[u8], dest: &Path, album: &str) -> AppResult<Vec<String>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| AppError::Bandcamp(format!("ZIP error: {e}")))?;

    let album_dir = dest.join(album);
    std::fs::create_dir_all(&album_dir)?;

    let mut files = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Bandcamp(format!("ZIP entry: {e}")))?;
        if !entry.is_file() {
            continue;
        }
        let name = entry.name().to_string();
        let ext = Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !AUDIO_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let file_name = Path::new(&name)
            .file_name()
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(&name));
        let out_path = album_dir.join(file_name);
        let mut out = std::fs::File::create(&out_path)?;
        std::io::copy(&mut entry, &mut out)?;
        files.push(out_path.to_string_lossy().to_string());
    }

    if files.is_empty() {
        return Err(AppError::Bandcamp("no audio files in the ZIP".into()));
    }
    Ok(files)
}

fn extension_for_format(fmt: &str) -> &'static str {
    match fmt {
        "flac" => "flac",
        "aiff-lossless" => "aiff",
        "wav" => "wav",
        "alac" => "m4a",
        "aac-hi" => "m4a",
        "mp3-v0" | "mp3-320" => "mp3",
        _ => "mp3",
    }
}

fn sanitize(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    s.trim().to_string()
}

/// Minimal HTML entity decoder for the data-blob attribute.
fn html_unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    #[test]
    fn html_unescape_decodes_entities() {
        assert_eq!(html_unescape("a&quot;b&amp;c&#39;d"), "a\"b&c'd");
    }

    #[test]
    fn extract_blob_reads_escaped_json() {
        let html = r#"<div id="x" data-blob="{&quot;digital_items&quot;:[{&quot;title&quot;:&quot;T&quot;}]}"></div>"#;
        let blob = extract_blob(html).unwrap();
        assert_eq!(blob["digital_items"][0]["title"], "T");
    }

    #[test]
    fn extract_blob_missing_marker_errors() {
        assert!(extract_blob("<div>no blob here</div>").is_err());
    }

    #[test]
    fn sanitize_replaces_path_chars() {
        assert_eq!(sanitize("A/B:C?"), "A_B_C_");
    }

    #[test]
    fn looks_like_zip_detects_pk_header() {
        assert!(looks_like_zip(b"PK\x03\x04rest"));
        assert!(!looks_like_zip(b"ID3 mp3 data"));
        assert!(!looks_like_zip(b"P"));
    }

    #[test]
    fn extension_for_format_maps_known_and_defaults() {
        assert_eq!(extension_for_format("flac"), "flac");
        assert_eq!(extension_for_format("aiff-lossless"), "aiff");
        assert_eq!(extension_for_format("wav"), "wav");
        assert_eq!(extension_for_format("alac"), "m4a");
        assert_eq!(extension_for_format("mp3-320"), "mp3");
        assert_eq!(extension_for_format("mp3-v0"), "mp3");
        assert_eq!(extension_for_format("something-else"), "mp3"); // fallback
    }

    fn build_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut zw = zip::ZipWriter::new(Cursor::new(&mut buf));
            for (name, data) in entries {
                zw.start_file(*name, SimpleFileOptions::default()).unwrap();
                zw.write_all(data).unwrap();
            }
            zw.finish().unwrap();
        }
        buf
    }

    #[test]
    fn extract_zip_keeps_only_audio_files() {
        let bytes = build_zip(&[
            ("01 Song.flac", b"flacdata"),
            ("cover.jpg", b"img"),
            ("notes.txt", b"txt"),
        ]);
        let dir = tempfile::tempdir().unwrap();
        let files = extract_zip(&bytes, dir.path(), "My Album").unwrap();
        assert_eq!(files.len(), 1);
        let out = &files[0];
        assert!(out.ends_with("My Album/01 Song.flac"), "got {out}");
        assert_eq!(std::fs::read(out).unwrap(), b"flacdata");
    }

    #[test]
    fn extract_zip_errors_without_audio() {
        let bytes = build_zip(&[("readme.txt", b"hi")]);
        let dir = tempfile::tempdir().unwrap();
        assert!(extract_zip(&bytes, dir.path(), "Album").is_err());
    }
}
