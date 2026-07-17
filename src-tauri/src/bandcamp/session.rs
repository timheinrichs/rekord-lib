use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::error::{AppError, AppResult};
use crate::metadata::net;
use crate::models::BandcampAccount;

pub const LOGIN_LABEL: &str = "bandcamp-login";

/// In der App verwalteter Bandcamp-Sitzungszustand.
#[derive(Default)]
pub struct BandcampState(pub Mutex<Option<Session>>);

/// Eine aktive Bandcamp-Sitzung (nur im Speicher, kein Passwort).
#[derive(Clone)]
pub struct Session {
    pub cookie_header: String,
    pub fan_id: i64,
    pub username: String,
}

/// Öffnet (oder fokussiert) das Bandcamp-Login-Fenster.
pub fn open_login(app: &AppHandle) -> AppResult<()> {
    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.set_focus();
        return Ok(());
    }
    let url = "https://bandcamp.com/login"
        .parse()
        .map_err(|e| AppError::Bandcamp(format!("URL-Fehler: {e}")))?;

    WebviewWindowBuilder::new(app, LOGIN_LABEL, WebviewUrl::External(url))
        .title("Bandcamp-Login")
        .inner_size(520.0, 760.0)
        .build()
        .map_err(|e| AppError::Bandcamp(format!("Login-Fenster fehlgeschlagen: {e}")))?;
    Ok(())
}

/// Liest die Bandcamp-Cookies aus dem Login- (oder Haupt-)Fenster als Header.
fn cookie_header(app: &AppHandle) -> AppResult<String> {
    let window = app
        .get_webview_window(LOGIN_LABEL)
        .or_else(|| app.get_webview_window("main"))
        .ok_or_else(|| AppError::Bandcamp("kein Fenster zum Cookie-Auslesen".into()))?;

    let url = "https://bandcamp.com"
        .parse()
        .map_err(|e| AppError::Bandcamp(format!("URL-Fehler: {e}")))?;

    let cookies = window
        .cookies_for_url(url)
        .map_err(|e| AppError::Bandcamp(format!("Cookies nicht lesbar: {e}")))?;

    if !cookies.iter().any(|c| c.name() == "identity") {
        return Err(AppError::Bandcamp(
            "Noch nicht eingeloggt (kein identity-Cookie gefunden).".into(),
        ));
    }

    let header = cookies
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");
    Ok(header)
}

/// Verifiziert den Login über collection_summary, speichert die Sitzung und
/// schließt das Login-Fenster.
pub async fn connect(app: &AppHandle, state: &BandcampState) -> AppResult<BandcampAccount> {
    let cookie = cookie_header(app)?;
    let client = net::client()?;

    let resp = client
        .get("https://bandcamp.com/api/fan/2/collection_summary")
        .header("Cookie", &cookie)
        .send()
        .await
        .map_err(|e| AppError::Bandcamp(format!("collection_summary: {e}")))?;

    if !resp.status().is_success() {
        return Err(AppError::Bandcamp(format!(
            "collection_summary HTTP {}",
            resp.status()
        )));
    }

    let json: Value = resp
        .json()
        .await
        .map_err(|e| AppError::Bandcamp(e.to_string()))?;

    let fan_id = json
        .get("fan_id")
        .and_then(Value::as_i64)
        .or_else(|| json.pointer("/collection_summary/fan_id").and_then(Value::as_i64))
        .ok_or_else(|| AppError::Bandcamp("nicht eingeloggt (keine fan_id)".into()))?;

    let username = json
        .pointer("/collection_summary/username")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| AppError::Bandcamp("State-Lock vergiftet".into()))?;
        *guard = Some(Session {
            cookie_header: cookie,
            fan_id,
            username: username.clone(),
        });
    }

    if let Some(w) = app.get_webview_window(LOGIN_LABEL) {
        let _ = w.close();
    }

    Ok(BandcampAccount { username, fan_id })
}

/// Liefert die aktuelle Sitzung (geklont) oder einen Fehler, falls nicht verbunden.
pub fn current(state: &BandcampState) -> AppResult<Session> {
    state
        .0
        .lock()
        .map_err(|_| AppError::Bandcamp("State-Lock vergiftet".into()))?
        .clone()
        .ok_or_else(|| AppError::Bandcamp("nicht mit Bandcamp verbunden".into()))
}

/// Meldet ab (verwirft die Sitzung im Speicher).
pub fn disconnect(state: &BandcampState) {
    if let Ok(mut guard) = state.0.lock() {
        *guard = None;
    }
}
