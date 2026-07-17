use std::io::Cursor;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::bandcamp::session::Session;
use crate::error::{AppError, AppResult};
use crate::metadata::net;

/// Bevorzugte Download-Formate (verlustfrei zuerst); das Ergebnis wird ohnehin
/// noch in das CDJ-Zielformat konvertiert.
const FORMAT_PREFERENCE: [&str; 4] = ["flac", "aiff-lossless", "wav", "mp3-320"];

/// Audio-Endungen, die aus einem Album-ZIP übernommen werden.
const AUDIO_EXTS: [&str; 7] = ["flac", "aiff", "aif", "wav", "mp3", "m4a", "aac"];

/// Lädt ein gekauftes Item herunter und liefert die (ggf. entpackten) Dateipfade.
pub async fn download(
    session: &Session,
    page_url: &str,
    dest_dir: &str,
) -> AppResult<Vec<String>> {
    // Eigener Client ohne Gesamt-Timeout (Alben können groß sein).
    let client = net::download_client()?;

    // 1. Download-Seite laden und data-blob extrahieren.
    let html = client
        .get(page_url)
        .header("Cookie", &session.cookie_header)
        .send()
        .await
        .map_err(|e| AppError::Bandcamp(format!("Download-Seite: {e}")))?
        .text()
        .await
        .map_err(|e| AppError::Bandcamp(e.to_string()))?;

    let blob = extract_blob(&html)?;

    // 2. Ersten digitalen Artikel + passendes Format wählen.
    let item = blob
        .get("digital_items")
        .and_then(Value::as_array)
        .and_then(|a| a.first())
        .ok_or_else(|| AppError::Bandcamp("keine digital_items in der Download-Seite".into()))?;

    let downloads = item
        .get("downloads")
        .and_then(Value::as_object)
        .ok_or_else(|| AppError::Bandcamp("keine downloads im Item".into()))?;

    let (fmt, url) = FORMAT_PREFERENCE
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
                "kein unterstütztes Format verfügbar (vorhanden: {:?})",
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

    // 3+4. Datei-Bytes holen (die .vrs=1-Anfrage liefert die Datei entweder
    // direkt oder als JSON mit der echten download_url).
    let bytes = fetch_download_bytes(&client, session, &url).await?;

    std::fs::create_dir_all(dest_dir)?;
    let safe_title = sanitize(title);

    // 5. Album-ZIP entpacken, Einzeltrack direkt speichern.
    if is_album || looks_like_zip(&bytes) {
        extract_zip(&bytes, Path::new(dest_dir), &safe_title)
    } else {
        let ext = extension_for_format(fmt);
        let out = Path::new(dest_dir).join(format!("{safe_title}.{ext}"));
        std::fs::write(&out, &bytes)?;
        Ok(vec![out.to_string_lossy().to_string()])
    }
}

/// Extrahiert und decodiert das `data-blob`-JSON aus der Download-Seite.
fn extract_blob(html: &str) -> AppResult<Value> {
    let marker = "data-blob=\"";
    let start = html
        .find(marker)
        .ok_or_else(|| AppError::Bandcamp("data-blob nicht gefunden".into()))?
        + marker.len();
    let rest = &html[start..];
    let end = rest
        .find('"')
        .ok_or_else(|| AppError::Bandcamp("data-blob nicht geschlossen".into()))?;
    let escaped = &rest[..end];
    let json = html_unescape(escaped);
    serde_json::from_str(&json)
        .map_err(|e| AppError::Bandcamp(format!("data-blob JSON-Fehler: {e}")))
}

/// Löst die tatsächliche Datei-URL auf. Der Blob-Link liefert entweder direkt
/// die Datei (Redirect) oder JSON mit `download_url`/`url`.
/// Holt die Datei-Bytes zu einem Format-Download-Link. Die `.vrs=1`-Anfrage
/// liefert entweder direkt die Datei (ZIP/Audio) oder JSON mit der echten URL.
async fn fetch_download_bytes(
    client: &reqwest::Client,
    session: &Session,
    url: &str,
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
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Bandcamp(e.to_string()))?
        .to_vec();

    if !status.is_success() {
        return Err(AppError::Bandcamp(format!("statdownload HTTP {status}")));
    }

    // Direkt eine Datei (ZIP/Audio)? Dann Bytes sofort verwenden.
    let is_json = ct.contains("json") || bytes.first() == Some(&b'{');
    if !is_json {
        return Ok(bytes);
    }

    // JSON-Variante: echte download_url extrahieren und laden.
    let json: Value = serde_json::from_slice(&bytes)
        .map_err(|e| AppError::Bandcamp(format!("statdownload JSON: {e}")))?;
    let dl = json
        .get("download_url")
        .or_else(|| json.get("url"))
        .or_else(|| json.get("retry_url"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            AppError::Bandcamp(format!(
                "keine download_url in statdownload-JSON (keys: {:?})",
                json.as_object().map(|o| o.keys().collect::<Vec<_>>())
            ))
        })?;

    let file = client
        .get(dl)
        .header("Cookie", &session.cookie_header)
        .send()
        .await
        .map_err(|e| AppError::Bandcamp(format!("Datei-Download: {e}")))?
        .bytes()
        .await
        .map_err(|e| AppError::Bandcamp(e.to_string()))?;
    Ok(file.to_vec())
}

fn looks_like_zip(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && &bytes[..2] == b"PK"
}

/// Entpackt Audiodateien aus einem Album-ZIP in einen Unterordner.
fn extract_zip(bytes: &[u8], dest: &Path, album: &str) -> AppResult<Vec<String>> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| AppError::Bandcamp(format!("ZIP-Fehler: {e}")))?;

    let album_dir = dest.join(album);
    std::fs::create_dir_all(&album_dir)?;

    let mut files = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Bandcamp(format!("ZIP-Eintrag: {e}")))?;
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
        return Err(AppError::Bandcamp("keine Audiodateien im ZIP".into()));
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

/// Minimaler HTML-Entity-Decoder für das data-blob-Attribut.
fn html_unescape(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}
