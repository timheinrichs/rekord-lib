use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::bandcamp::session::Session;
use crate::commands::is_inside;
use crate::error::{AppError, AppResult};
use crate::metadata::net;

/// Ceilings on what one download may cost.
///
/// Everything below this comment arrives from a server we do not control, over
/// a session cookie that can be stale, and lands in the user's library folder.
/// Each limit has a plausible cause rather than a hypothetical one: a redirect
/// to a login page instead of a file, an archive that inflates far beyond what
/// was transferred, a name that is not a name. They are generous — a lossless
/// album of a long DJ set is a few hundred megabytes — so a real purchase never
/// meets them.
const MAX_DOWNLOAD: u64 = 4 * 1024 * 1024 * 1024;
/// Per extracted file, and per archive in total.
const MAX_ENTRY: u64 = 2 * 1024 * 1024 * 1024;
const MAX_EXTRACTED: u64 = 8 * 1024 * 1024 * 1024;
/// A release is tracks, not a file system.
const MAX_ENTRIES: usize = 1000;
/// A statdownload answer is a few hundred bytes of JSON. Anything larger is not
/// one, and must not be read back into memory to find that out.
const MAX_JSON: u64 = 1024 * 1024;

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

/// The partial download, removed unless it turned into a finished file.
///
/// While the bytes only lived in memory, every early return between "started
/// downloading" and "finished" was free. On disk a cancelled or capped download
/// would stay behind in the user's library folder as a half file, so the removal
/// is drop glue rather than a line in each error path.
struct PartFile(PathBuf);

impl PartFile {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for PartFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Streams a response body into `part` and reports progress (throttled, ~every
/// 256 KB). Returns the number of bytes written.
///
/// To a file rather than into a `Vec`: an album is hundreds of megabytes, and
/// the length the server announces is not a promise about what it sends.
async fn stream_to_file(
    mut resp: reqwest::Response,
    part: &Path,
    app: &AppHandle,
    key: &str,
    stage: &str,
    cancel: &AtomicBool,
) -> AppResult<u64> {
    let announced = resp.content_length().unwrap_or(0);
    if announced > MAX_DOWNLOAD {
        return Err(AppError::Bandcamp(format!(
            "download refused: {announced} bytes announced, over the {MAX_DOWNLOAD} byte limit"
        )));
    }
    let mut file = tokio::fs::File::create(part).await?;
    let mut written: u64 = 0;
    let mut last_emit: u64 = 0;
    emit_progress(app, key, 0, announced, stage);
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| AppError::Bandcamp(format!("Download stream: {e}")))?
    {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Bandcamp("Download cancelled".into()));
        }
        written += chunk.len() as u64;
        if written > MAX_DOWNLOAD {
            return Err(AppError::Bandcamp(format!(
                "download stopped at the {MAX_DOWNLOAD} byte limit"
            )));
        }
        file.write_all(&chunk).await?;
        if written - last_emit >= 256 * 1024 {
            last_emit = written;
            emit_progress(app, key, written, announced.max(written), stage);
        }
    }
    file.flush().await?;
    emit_progress(app, key, written, announced.max(written), stage);
    Ok(written)
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
    cancel: &AtomicBool,
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

    // 3+4. Fetch the file (the .vrs=1 request returns the file either directly
    // or as JSON with the real download_url) – streamed to disk with progress.
    std::fs::create_dir_all(dest_dir)?;
    let part = PartFile(part_path(app, key)?);
    fetch_download_file(&client, session, key, &url, app, part.path(), cancel).await?;

    // The title decides a folder or a file name, and it comes from the page.
    let safe_title = safe_name(title).unwrap_or_else(|| "bandcamp".to_string());

    // 5. Extract album ZIP, save a single track directly.
    let done = std::fs::metadata(part.path())?.len();
    if is_album || looks_like_zip(part.path()) {
        emit_progress(app, key, done, done, "Extracting");
        extract_zip(part.path(), Path::new(dest_dir), &safe_title)
    } else {
        emit_progress(app, key, done, done, "Saving");
        let ext = extension_for_format(fmt);
        let out = Path::new(dest_dir).join(format!("{safe_title}.{ext}"));
        move_into_place(part.path(), &out)?;
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

/// Content type of a response, lowercased, without its parameters.
fn content_type(resp: &reqwest::Response) -> String {
    resp.headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_lowercase()
}

fn check_status(resp: &reqwest::Response, what: &str) -> AppResult<()> {
    let status = resp.status();
    if !status.is_success() {
        return Err(AppError::Bandcamp(format!("{what} HTTP {status}")));
    }
    Ok(())
}

/// A web page where a file was expected — which is what an expired session
/// returns: a login page, saved as if it were the album.
///
/// Judged on the bytes as well as on the header, because the content type on
/// this path has never been reliable: the JSON answer is the reason the old code
/// sniffed the first byte instead of believing it. No audio format and no ZIP
/// begins with `<`.
fn is_web_page(part: &Path, content_type: &str) -> bool {
    if content_type.starts_with("text/html") {
        return true;
    }
    let mut head = [0u8; 1];
    std::fs::File::open(part)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok()
        && head[0] == b'<'
}

fn web_page_error(what: &str) -> AppError {
    AppError::Bandcamp(format!(
        "{what}: got a web page instead of a file — the Bandcamp session may have expired"
    ))
}

/// Downloads the file behind a format link into `part`. The `.vrs=1` request
/// returns either the file directly (ZIP/audio) or JSON with the real URL.
async fn fetch_download_file(
    client: &reqwest::Client,
    session: &Session,
    key: &str,
    url: &str,
    app: &AppHandle,
    part: &Path,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let probe_url = if url.contains('?') {
        format!("{url}&.vrs=1")
    } else {
        format!("{url}?.vrs=1")
    };

    let resp = client
        .get(&probe_url)
        .header("Cookie", &session.cookie_header)
        .header(
            reqwest::header::ACCEPT,
            "application/json, text/javascript, */*",
        )
        .send()
        .await
        .map_err(|e| AppError::Bandcamp(format!("statdownload: {e}")))?;
    check_status(&resp, "statdownload")?;
    let ct = content_type(&resp);

    // Read the body (for a direct file this is already the large download).
    stream_to_file(resp, part, app, key, "Downloading", cancel).await?;

    // A file directly (ZIP/audio)? Then it is already where it belongs. The
    // page check comes after the parse, not before it: this response is
    // sometimes JSON under a content type that does not say so, and refusing it
    // on the header alone would fail every download rather than follow the
    // `download_url` inside it.
    let Some(json) = json_answer(part, &ct)? else {
        return if is_web_page(part, &ct) {
            Err(web_page_error("statdownload"))
        } else {
            Ok(())
        };
    };

    // JSON variant: extract the real download_url and stream the file.
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
    check_status(&file_resp, "File download")?;
    let ct = content_type(&file_resp);
    stream_to_file(file_resp, part, app, key, "Downloading", cancel).await?;
    if is_web_page(part, &ct) {
        return Err(web_page_error("File download"));
    }
    Ok(())
}

/// The statdownload answer, when the response was JSON rather than the file.
///
/// Recognised by its content type or by a leading `{`, as before — but only for
/// a body small enough to be one, so an album is never read back into memory to
/// find out that it is not JSON.
fn json_answer(part: &Path, content_type: &str) -> AppResult<Option<Value>> {
    let says_json = content_type.contains("json");
    if std::fs::metadata(part)?.len() > MAX_JSON {
        // A body that calls itself JSON and is a megabyte long is not the
        // answer we are looking for — and saving it as the album would be worse
        // than saying so.
        return if says_json {
            Err(AppError::Bandcamp(
                "statdownload answered with more JSON than an answer can be".into(),
            ))
        } else {
            Ok(None)
        };
    }
    let bytes = std::fs::read(part)?;
    if !says_json && bytes.first() != Some(&b'{') {
        return Ok(None);
    }
    let json = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::Bandcamp(format!("statdownload JSON: {e}")))?;
    Ok(Some(json))
}

fn looks_like_zip(path: &Path) -> bool {
    let mut head = [0u8; 2];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut head))
        .is_ok()
        && &head == b"PK"
}

/// What an archive may cost while being unpacked. A field rather than a
/// constant at the call site so the limits can be tested without writing
/// gigabytes to prove that they hold.
#[derive(Clone, Copy)]
struct Limits {
    entries: usize,
    per_entry: u64,
    total: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            entries: MAX_ENTRIES,
            per_entry: MAX_ENTRY,
            total: MAX_EXTRACTED,
        }
    }
}

/// Extracts audio files from an album ZIP into a subfolder.
///
/// Everything about an entry is attacker-controlled: its name, its declared
/// size, its mode. So the name is reduced to a sanitised last component (never
/// a path, never the raw fallback that a name ending in `/..` used to reach),
/// symlinks are skipped, the written bytes are counted rather than believed,
/// and each output path is checked to be inside the album folder before it is
/// created.
fn extract_zip(archive_path: &Path, dest: &Path, album: &str) -> AppResult<Vec<String>> {
    extract_zip_within(archive_path, dest, album, Limits::default())
}

fn extract_zip_within(
    archive_path: &Path,
    dest: &Path,
    album: &str,
    limits: Limits,
) -> AppResult<Vec<String>> {
    let file = std::fs::File::open(archive_path)?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| AppError::Bandcamp(format!("ZIP error: {e}")))?;
    if archive.len() > limits.entries {
        return Err(AppError::Bandcamp(format!(
            "archive refused: {} entries, over the limit of {}",
            archive.len(),
            limits.entries
        )));
    }

    let album_dir = dest.join(album);
    std::fs::create_dir_all(&album_dir)?;
    let album_str = album_dir.to_string_lossy().to_string();

    let mut files = Vec::new();
    let mut extracted: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Bandcamp(format!("ZIP entry: {e}")))?;
        // A symlink is stored as a file whose content is its target — following
        // one later would write outside the folder we just checked.
        let is_symlink = entry
            .unix_mode()
            .is_some_and(|m| m & 0o170000 == 0o120000);
        if !entry.is_file() || is_symlink {
            continue;
        }
        let name = entry.name().to_string();
        let Some(file_name) = Path::new(&name)
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(safe_name)
        else {
            continue;
        };
        let ext = Path::new(&file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !AUDIO_EXTS.contains(&ext.as_str()) {
            continue;
        }

        // Sanitising maps different entries onto the same name — a multi-disc
        // release has `CD1/01 Song.flac` next to `CD2/01 Song.flac`, and both
        // become `01 Song.flac`. Without this the second overwrites the first
        // and the ledger records one path twice.
        let out_path = album_dir.join(free_name(&album_dir, &file_name));
        // Belt to the sanitising brace: nothing leaves the album folder.
        if !is_inside(&album_str, &out_path.to_string_lossy()) {
            continue;
        }

        // One byte over the cap is enough to know it was exceeded; the declared
        // size is not consulted, because an archive can declare anything.
        let cap = limits.per_entry.min(limits.total - extracted);
        let mut out = std::fs::File::create(&out_path)?;
        let copied = std::io::copy(&mut Read::take(&mut entry, cap + 1), &mut out)?;
        if copied > cap {
            drop(out);
            // Everything this call wrote goes with it. A refused download that
            // leaves half an album behind is worse than one that fails cleanly:
            // the ledger records nothing, so the sync would keep offering the
            // release while its first tracks already sit in the library.
            let _ = std::fs::remove_file(&out_path);
            for written in &files {
                let _ = std::fs::remove_file(written);
            }
            let _ = std::fs::remove_dir(&album_dir);
            return Err(AppError::Bandcamp(
                "archive refused: it extracts to more than the size limit allows".into(),
            ));
        }
        extracted += copied;
        files.push(out_path.to_string_lossy().to_string());
    }

    if files.is_empty() {
        return Err(AppError::Bandcamp("no audio files in the ZIP".into()));
    }
    Ok(files)
}

/// `name`, or `name (2)` — the first form the folder does not already hold.
fn free_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path.extension().and_then(|e| e.to_str());
    for n in 2..1000 {
        let candidate = match ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        if !dir.join(&candidate).exists() {
            return candidate;
        }
    }
    // A thousand entries of the same name is not a release; let the write fail
    // rather than loop.
    name.to_string()
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

/// Where the bytes are collected while they are still arriving.
///
/// In the app's cache folder, deliberately not in the library: the library is
/// watched recursively, and a file that grows for minutes would fire a re-walk
/// of the whole collection every 700 ms while it does. It also means a leftover
/// part file after a crash sits somewhere the user never has to look.
fn part_path(app: &AppHandle, key: &str) -> AppResult<PathBuf> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| AppError::Bandcamp(format!("no cache folder: {e}")))?
        .join("downloads");
    std::fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{}.part", part_key(key))))
}

/// The item key as a file name: hashed, not filtered.
///
/// Filtering the characters out collapses distinct keys onto one name — and two
/// downloads sharing a part file would have one of them writing while the
/// other's guard deletes it. A hash has one name per key and no characters that
/// mean anything to a file system.
fn part_key(key: &str) -> String {
    // FNV-1a, because this needs to be stable and collision-free enough for a
    // handful of concurrent names, not cryptographic.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in key.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Moves the finished download to where it belongs.
///
/// A rename when both are on the same volume, a copy when they are not — the
/// cache folder is on the system disk and a library often is not.
fn move_into_place(part: &Path, out: &Path) -> AppResult<()> {
    if std::fs::rename(part, out).is_ok() {
        return Ok(());
    }
    // A copy can stop halfway — a full disk is the ordinary way — and what it
    // leaves is a truncated file with a real track's name, which the watcher
    // and the next scan would take for music.
    if let Err(e) = std::fs::copy(part, out) {
        let _ = std::fs::remove_file(out);
        return Err(e.into());
    }
    std::fs::remove_file(part)?;
    Ok(())
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

/// A name from untrusted input, usable as a single entry in a folder — or
/// nothing, when there is no such name left.
///
/// `sanitize` alone was not enough: it leaves `.` and `..` untouched, and both
/// name the folder above rather than a file in it.
fn safe_name(name: &str) -> Option<String> {
    let s = sanitize(name);
    // A leading dot hides the file and, worse, is how our own part file is
    // named. Neither belongs to a downloaded track.
    let s = s.trim_start_matches('.').trim().to_string();
    if s.is_empty() {
        return None;
    }
    Some(s)
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
    fn safe_name_rejects_what_is_not_a_name() {
        // The whole point: `..` is the folder above, not a file in this one.
        assert_eq!(safe_name(".."), None);
        assert_eq!(safe_name("."), None);
        assert_eq!(safe_name("   "), None);
        assert_eq!(safe_name(""), None);
        // A hidden name is not one either — our own part file is called that.
        assert_eq!(safe_name(".rekord-lib-x.part").as_deref(), Some("rekord-lib-x.part"));
        assert_eq!(safe_name("Track 01.flac").as_deref(), Some("Track 01.flac"));
        assert_eq!(safe_name("../evil.flac").as_deref(), Some("_evil.flac"));
    }

    #[test]
    fn looks_like_zip_detects_pk_header() {
        let dir = tempfile::tempdir().unwrap();
        let zip = dir.path().join("a");
        std::fs::write(&zip, b"PK\x03\x04rest").unwrap();
        assert!(looks_like_zip(&zip));
        let mp3 = dir.path().join("b");
        std::fs::write(&mp3, b"ID3 mp3 data").unwrap();
        assert!(!looks_like_zip(&mp3));
        let tiny = dir.path().join("c");
        std::fs::write(&tiny, b"P").unwrap();
        assert!(!looks_like_zip(&tiny));
        assert!(!looks_like_zip(&dir.path().join("missing")));
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
            let mut zw = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            for (name, data) in entries {
                zw.start_file(*name, SimpleFileOptions::default()).unwrap();
                zw.write_all(data).unwrap();
            }
            zw.finish().unwrap();
        }
        buf
    }

    /// The archive as a file, the way `download` hands it over.
    fn zip_file(dir: &Path, entries: &[(&str, &[u8])]) -> PathBuf {
        let path = dir.join("archive.part");
        std::fs::write(&path, build_zip(entries)).unwrap();
        path
    }

    #[test]
    fn extract_zip_keeps_only_audio_files() {
        let dir = tempfile::tempdir().unwrap();
        let archive = zip_file(
            dir.path(),
            &[
                ("01 Song.flac", b"flacdata"),
                ("cover.jpg", b"img"),
                ("notes.txt", b"txt"),
            ],
        );
        let files = extract_zip(&archive, dir.path(), "My Album").unwrap();
        assert_eq!(files.len(), 1);
        let out = &files[0];
        assert!(out.ends_with("My Album/01 Song.flac"), "got {out}");
        assert_eq!(std::fs::read(out).unwrap(), b"flacdata");
    }

    #[test]
    fn extract_zip_errors_without_audio() {
        let dir = tempfile::tempdir().unwrap();
        let archive = zip_file(dir.path(), &[("readme.txt", b"hi")]);
        assert!(extract_zip(&archive, dir.path(), "Album").is_err());
    }

    #[test]
    fn extract_zip_writes_a_traversing_name_into_the_album_folder() {
        // The name is not a path: only its last component is used, so the file
        // lands in the album folder and nothing above it is touched.
        let dir = tempfile::tempdir().unwrap();
        let dest = dir.path().join("library");
        let archive = zip_file(
            dir.path(),
            &[("../../../evil.flac", b"x"), ("/abs/evil2.flac", b"y")],
        );
        let files = extract_zip(&archive, &dest, "Album").unwrap();
        assert_eq!(files.len(), 2);
        for f in &files {
            assert!(f.contains("library/Album/"), "escaped: {f}");
        }
        assert!(!dir.path().join("evil.flac").exists());
    }

    #[test]
    fn extract_zip_skips_an_entry_whose_name_is_only_dots() {
        // `Path::file_name()` answers None here, which is exactly where the old
        // code fell back to the raw entry name — and that name is a path.
        let dir = tempfile::tempdir().unwrap();
        let archive = zip_file(
            dir.path(),
            &[("sub/..", b"x"), ("ok.flac", b"audio"), ("..flac", b"z")],
        );
        let files = extract_zip(&archive, dir.path(), "Album").unwrap();
        // `sub/..` has no last component at all; `..flac` sanitises to `flac`,
        // which is a name with no extension and therefore not audio.
        assert_eq!(files.len(), 1, "got {files:?}");
        assert!(files[0].ends_with("Album/ok.flac"));
    }

    #[test]
    fn extract_zip_stops_at_the_extraction_limit() {
        // Not reachable with real files, but a bomb declares little and writes a
        // lot — so the written bytes are what is counted.
        let dir = tempfile::tempdir().unwrap();
        let big = vec![0u8; 1024];
        let archive = zip_file(dir.path(), &[("a.flac", &big)]);
        // The cap is checked against what has been written, so a limit below the
        // entry's real size must abort rather than truncate.
        let limits = Limits {
            per_entry: 512,
            total: 512,
            ..Limits::default()
        };
        let err = extract_zip_within(&archive, dir.path(), "Album", limits).unwrap_err();
        assert!(format!("{err}").contains("size limit"), "got {err}");
        // And it leaves no truncated file behind.
        assert!(!dir.path().join("Album").join("a.flac").exists());
    }

    #[test]
    fn extract_zip_keeps_both_sides_of_a_multi_disc_release() {
        // Two entries, one name after sanitising: the second must not overwrite
        // the first, and the returned list must not name one file twice.
        let dir = tempfile::tempdir().unwrap();
        let archive = zip_file(
            dir.path(),
            &[("CD1/01 Song.flac", b"one"), ("CD2/01 Song.flac", b"two")],
        );
        let files = extract_zip(&archive, dir.path(), "Album").unwrap();
        assert_eq!(files.len(), 2);
        assert_ne!(files[0], files[1]);
        assert!(files[1].ends_with("Album/01 Song (2).flac"), "got {}", files[1]);
        assert_eq!(std::fs::read(&files[0]).unwrap(), b"one");
        assert_eq!(std::fs::read(&files[1]).unwrap(), b"two");
    }

    #[test]
    fn extract_zip_leaves_nothing_behind_when_it_refuses() {
        // The first entry fits, the second does not: neither may stay.
        let dir = tempfile::tempdir().unwrap();
        let archive = zip_file(
            dir.path(),
            &[("a.flac", &[0u8; 400]), ("b.flac", &[0u8; 400])],
        );
        let limits = Limits {
            per_entry: 500,
            total: 500,
            ..Limits::default()
        };
        assert!(extract_zip_within(&archive, dir.path(), "Album", limits).is_err());
        assert!(!dir.path().join("Album").exists());
    }

    #[test]
    fn part_key_is_one_name_per_key() {
        // Two keys that a filter would collapse onto the same file name.
        assert_ne!(part_key("../../etc/passwd"), part_key("etc/passwd"));
        assert_ne!(part_key("a b"), part_key("ab"));
        // Stable, and a plain file name.
        assert_eq!(part_key("abc"), part_key("abc"));
        assert!(part_key("../x").chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn is_web_page_reads_the_bytes_as_well_as_the_header() {
        let dir = tempfile::tempdir().unwrap();
        let html = dir.path().join("html");
        std::fs::write(&html, b"<!DOCTYPE html><html>").unwrap();
        let audio = dir.path().join("audio");
        std::fs::write(&audio, b"fLaC\x00").unwrap();

        assert!(is_web_page(&html, "application/octet-stream"));
        assert!(is_web_page(&audio, "text/html; charset=utf-8"));
        assert!(!is_web_page(&audio, "audio/flac"));
    }

    #[test]
    fn extract_zip_refuses_an_archive_with_too_many_entries() {
        let dir = tempfile::tempdir().unwrap();
        let archive = zip_file(dir.path(), &[("a.flac", b"x"), ("b.flac", b"y")]);
        let limits = Limits {
            entries: 1,
            ..Limits::default()
        };
        let err = extract_zip_within(&archive, dir.path(), "Album", limits).unwrap_err();
        assert!(format!("{err}").contains("entries"), "got {err}");
    }

    #[test]
    fn part_file_removes_itself() {
        // A cancelled download must not leave half a track in the library.
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".rekord-lib-x.part");
        {
            let part = PartFile(path.clone());
            std::fs::write(part.path(), b"half").unwrap();
            assert!(path.exists());
        }
        assert!(!path.exists());
    }
}
