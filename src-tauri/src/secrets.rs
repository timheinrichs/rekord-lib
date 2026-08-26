//! The one real secret the app holds, kept where secrets belong.
//!
//! The Discogs consumer key and secret used to sit in plaintext in
//! `rekord-lib.json` in the app data folder, and travelled from the frontend to
//! the backend as arguments on every suggestion request. They now live in the
//! macOS Keychain, and the frontend never sees the secret again: it writes it
//! once and asks only whether one is stored.
//!
//! Two forms are accepted, one at a time: the user's own personal access token,
//! or a registered application's consumer key and secret. They buy the same
//! thing — Discogs' higher rate limit — so the token is offered first, being a
//! string somebody copies rather than an application somebody registers.
//!
//! **It fails closed.** When the Keychain refuses — the user denied access, or
//! an ad-hoc-signed update no longer matches the item's ACL — nothing falls back
//! to the JSON store. Settings says the credentials are unavailable and asks for
//! them again. Suggestions do not stop: `metadata::discogs` searches without a
//! credential too, at the lower limit Discogs applies to anonymous callers.
//! MusicBrainz keeps working either way.

use std::time::{SystemTime, UNIX_EPOCH};

use keyring::Entry;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

use crate::metadata::discogs::Credential;

/// The Keychain items a Discogs credential can occupy.
///
/// Two forms, one at a time: a personal access token, or a registered
/// application's consumer key and secret. `saved-at` is the odd one out — not a
/// secret, but the label settings shows instead of the credential itself.
const KEY_ACCOUNT: &str = "discogs-consumer-key";
const SECRET_ACCOUNT: &str = "discogs-consumer-secret";
const TOKEN_ACCOUNT: &str = "discogs-token";
const SAVED_AT_ACCOUNT: &str = "discogs-saved-at";
const ALL_ACCOUNTS: [&str; 4] = [
    KEY_ACCOUNT,
    SECRET_ACCOUNT,
    TOKEN_ACCOUNT,
    SAVED_AT_ACCOUNT,
];

/// Store file and the keys the credentials used to live under.
const STORE_FILE: &str = "rekord-lib.json";
const SETTINGS_KEY: &str = "settings";
const LEGACY_KEY: &str = "discogs_key";
const LEGACY_SECRET: &str = "discogs_secret";

/// Which form is stored. Not the value — see `DiscogsStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiscogsKind {
    Token,
    App,
}

/// What settings needs to know: whether there is a credential, without ever
/// being told what it is.
///
/// It used to carry the consumer key, on the argument that the key is not the
/// secret half and seeing it tells you which application is stored. That was
/// wrong twice over: it is still credential material, and it put itself on
/// every screenshot of the settings screen. The form and the date it was saved
/// answer the same question — *which one is in there* — and neither is worth
/// anything to anybody who reads it.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct DiscogsStatus {
    /// A usable credential is stored and readable.
    pub stored: bool,
    /// The Keychain itself could not be used — see the module comment.
    pub unavailable: bool,
    /// Which of the two forms is stored.
    pub kind: Option<DiscogsKind>,
    /// When it was stored, in Unix milliseconds.
    pub saved_at: Option<i64>,
}

/// The service name for the Keychain items, per bundle identifier.
///
/// The identifier and not a constant: the `-devtest` build has its own, so a dev
/// run can neither read nor overwrite the installed app's credentials — the same
/// separation the devtest database and settings already have.
pub fn service(identifier: &str) -> String {
    format!("{identifier}.discogs")
}

fn entry(app: &AppHandle, account: &str) -> keyring::Result<Entry> {
    Entry::new(&service(&app.config().identifier), account)
}

/// Deletes one item. A missing item is not an error — the end state is what was
/// asked for either way.
fn delete(app: &AppHandle, account: &str) -> keyring::Result<()> {
    match entry(app, account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}

/// Records when a credential was stored.
///
/// Best effort: the date is a label on the screen, and failing to write it must
/// not fail the credential it labels. A missing date simply is not shown.
fn stamp(app: &AppHandle) {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    if let Ok(e) = entry(app, SAVED_AT_ACCOUNT) {
        let _ = e.set_password(&ms.to_string());
    }
}

/// The credential to send, if there is one. `None` means "search anonymously",
/// which Discogs allows at a lower rate limit.
///
/// A token wins over a pair, which cannot normally both exist — `set_token` and
/// `set_app` each clear the other form first. The order is stated anyway so the
/// answer is defined even for a Keychain somebody edited by hand.
pub fn discogs(app: &AppHandle) -> Option<Credential> {
    if let Ok(Some(token)) = read(app, TOKEN_ACCOUNT) {
        return Some(Credential::Token(token));
    }
    let (Ok(Some(key)), Ok(Some(secret))) = (read(app, KEY_ACCOUNT), read(app, SECRET_ACCOUNT))
    else {
        return None;
    };
    Some(Credential::App { key, secret })
}

/// Stores a personal access token, replacing whatever was there.
pub fn set_token(app: &AppHandle, token: &str) -> keyring::Result<()> {
    non_empty(token, "token")?;
    replace(app, |app| entry(app, TOKEN_ACCOUNT)?.set_password(token))
}

/// Stores a consumer key and secret, replacing whatever was there.
///
/// Both or neither: a key stored without its secret is not a credential, and it
/// would sit there unused and unshown, because `status` reports a pair or
/// nothing.
pub fn set_app(app: &AppHandle, key: &str, secret: &str) -> keyring::Result<()> {
    non_empty(key, "consumer key")?;
    non_empty(secret, "consumer secret")?;
    replace(app, |app| {
        entry(app, KEY_ACCOUNT)?.set_password(key)?;
        entry(app, SECRET_ACCOUNT)?.set_password(secret)
    })
}

/// Refuses an empty value, before anything is cleared.
///
/// `replace` deletes what is stored before it writes, so an empty value would
/// otherwise remove a working credential, write an item `read` maps straight
/// back to "nothing stored", and report success. Only a disabled button in
/// settings stands between that and the user today, and a disabled button is
/// not where this rule belongs.
fn non_empty(value: &str, what: &str) -> keyring::Result<()> {
    if value.trim().is_empty() {
        return Err(keyring::Error::Invalid(
            what.to_string(),
            "must not be empty".to_string(),
        ));
    }
    Ok(())
}

/// Clears every form first, then writes the new one.
///
/// In that order, because the alternative is ambiguity: a new pair written
/// while an old token survives would be silently ignored, since `discogs` reads
/// the token first. Clearing first can cost the old credential if the write
/// then fails — which the caller sees as an error and answers by entering it
/// again, the same way the half-written pair has always been handled.
fn replace(
    app: &AppHandle,
    write: impl Fn(&AppHandle) -> keyring::Result<()>,
) -> keyring::Result<()> {
    clear_discogs(app)?;
    if let Err(e) = write(app) {
        let _ = clear_discogs(app);
        return Err(e);
    }
    stamp(app);
    Ok(())
}

/// Removes every form. A missing item is not an error.
pub fn clear_discogs(app: &AppHandle) -> keyring::Result<()> {
    for account in ALL_ACCOUNTS {
        delete(app, account)?;
    }
    Ok(())
}

/// Reads one half. `Ok(None)` is "nothing stored", `Err(())` is "could not ask".
///
/// The distinction is the whole reason `unavailable` exists, and it has to hold
/// for **both** items: a key that reads while the secret's read is refused is
/// exactly the ad-hoc-signed-update case, and reporting it as "nothing stored"
/// would show an empty form with no explanation and silently empty suggestions.
fn read(app: &AppHandle, account: &str) -> Result<Option<String>, ()> {
    match entry(app, account).and_then(|e| e.get_password()) {
        Ok(value) if value.is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(()),
    }
}

/// Whether a credential is stored, and whether the Keychain answered at all.
pub fn status(app: &AppHandle) -> DiscogsStatus {
    let (Ok(key), Ok(secret), Ok(token)) = (
        read(app, KEY_ACCOUNT),
        read(app, SECRET_ACCOUNT),
        read(app, TOKEN_ACCOUNT),
    ) else {
        return DiscogsStatus {
            unavailable: true,
            ..DiscogsStatus::default()
        };
    };
    // The date is a label, not a credential: one that will not read costs the
    // line on screen, not the verdict.
    let saved_at = read(app, SAVED_AT_ACCOUNT)
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok());
    status_from(
        key.as_deref(),
        secret.as_deref(),
        token.as_deref(),
        saved_at,
    )
}

/// The verdict, given what the Keychain held. Pure, so the precedence and the
/// half-a-pair case are tested without a Keychain.
fn status_from(
    key: Option<&str>,
    secret: Option<&str>,
    token: Option<&str>,
    saved_at: Option<i64>,
) -> DiscogsStatus {
    let kind = if token.is_some() {
        Some(DiscogsKind::Token)
    } else if key.is_some() && secret.is_some() {
        Some(DiscogsKind::App)
    } else {
        None
    };
    DiscogsStatus {
        stored: kind.is_some(),
        unavailable: false,
        kind,
        // No credential, no date: a stamp left behind by a removed credential
        // would otherwise date something that is not there.
        saved_at: kind.and(saved_at),
    }
}

/// The credentials to migrate out of the settings value, if it still holds any.
///
/// Pure, so the decision is tested even though the Keychain is not: a pair is
/// only worth moving when both halves are there and neither is empty.
pub fn legacy_pair(settings: Option<&serde_json::Value>) -> Option<(String, String)> {
    let settings = settings?;
    let key = settings.get(LEGACY_KEY)?.as_str()?.trim();
    let secret = settings.get(LEGACY_SECRET)?.as_str()?.trim();
    if key.is_empty() || secret.is_empty() {
        return None;
    }
    Some((key.to_string(), secret.to_string()))
}

/// Moves a credential left in the JSON store into the Keychain, once.
///
/// The keys are deleted only after the Keychain has taken the values, in the
/// shape `db::migrate::shed_legacy_keys` uses: losing the only copy of a
/// credential to a failed write would be worse than leaving it where it is for
/// one more start. The keys are removed even when there is nothing to move, so
/// a half-filled pair does not stay in plaintext forever.
pub fn migrate_from_store(app: &AppHandle) {
    let Ok(store) = app.store(STORE_FILE) else {
        return;
    };
    let Some(mut settings) = store.get(SETTINGS_KEY) else {
        return;
    };
    let Some(map) = settings.as_object_mut() else {
        return;
    };
    let has_keys = map.contains_key(LEGACY_KEY) || map.contains_key(LEGACY_SECRET);

    match legacy_plan(has_keys, discogs(app).is_some()) {
        Legacy::Leave => return,
        Legacy::Move => {
            if let Some((key, secret)) = legacy_pair(Some(&settings)) {
                if let Err(e) = set_app(app, &key, &secret) {
                    eprintln!("Could not move the Discogs credentials into the Keychain: {e}");
                    return;
                }
                println!("Discogs credentials moved into the Keychain");
            }
        }
        // Dropped without being read: something newer is already stored.
        Legacy::Shed => {}
    }

    let map = settings.as_object_mut().expect("checked above");
    map.remove(LEGACY_KEY);
    map.remove(LEGACY_SECRET);
    store.set(SETTINGS_KEY, settings);
    if let Err(e) = store.save() {
        eprintln!("Could not remove the Discogs credentials from the store: {e}");
    }
}

/// What start-up does about a legacy pair left in the JSON store.
#[derive(Debug, PartialEq, Eq)]
enum Legacy {
    /// Move it into the Keychain, then delete the keys.
    Move,
    /// Delete the keys; a newer credential is already stored.
    Shed,
    /// Nothing to do.
    Leave,
}

/// The rule, apart from the store and the Keychain that make it true.
///
/// The second case is the one that had to be added: the keys survive a start
/// when the Keychain refused the write, and by the next start the user may have
/// entered a token instead. Migrating on top of that would delete the newer
/// credential — `set_app` clears every form before it writes — and put the
/// stale pair back in its place.
fn legacy_plan(has_keys: bool, has_credential: bool) -> Legacy {
    match (has_keys, has_credential) {
        (false, _) => Legacy::Leave,
        (true, true) => Legacy::Shed,
        (true, false) => Legacy::Move,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn service_is_per_bundle_identifier() {
        // The dev build must not reach the installed app's credentials.
        assert_ne!(
            service("com.timheinrichs.rekord-lib"),
            service("com.timheinrichs.rekord-lib-devtest")
        );
        assert_eq!(
            service("com.timheinrichs.rekord-lib"),
            "com.timheinrichs.rekord-lib.discogs"
        );
    }

    #[test]
    fn a_token_beats_a_pair_and_half_a_pair_is_nothing() {
        let stamp = Some(1_700_000_000_000);
        // A token wins: it is what `discogs` sends, so it is what settings says.
        let both = status_from(Some("k"), Some("s"), Some("t"), stamp);
        assert_eq!(both.kind, Some(DiscogsKind::Token));
        assert!(both.stored && !both.unavailable);

        assert_eq!(
            status_from(Some("k"), Some("s"), None, stamp).kind,
            Some(DiscogsKind::App)
        );
        // Half a pair is not a credential — nothing to send, nothing to show.
        let half = status_from(Some("k"), None, None, stamp);
        assert_eq!(half.kind, None);
        assert!(!half.stored);
    }

    #[test]
    fn the_date_belongs_to_a_credential_that_is_there() {
        let stamp = Some(1_700_000_000_000);
        assert_eq!(status_from(None, None, Some("t"), stamp).saved_at, stamp);
        // A stamp left behind by a removed credential dates nothing.
        assert_eq!(status_from(None, None, None, stamp).saved_at, None);
        // And a credential whose stamp would not read is still a credential.
        let unstamped = status_from(None, None, Some("t"), None);
        assert!(unstamped.stored && unstamped.saved_at.is_none());
    }

    #[test]
    fn a_status_carries_no_credential_material() {
        // The bug this replaced: the consumer key travelled to the frontend and
        // was rendered in settings. Serialising is where it would come back.
        let json = serde_json::to_string(&status_from(
            Some("secret-key"),
            Some("secret-secret"),
            None,
            Some(1_700_000_000_000),
        ))
        .expect("serialisable");
        assert!(!json.contains("secret-key"));
        assert!(!json.contains("secret-secret"));
        assert!(json.contains(r#""kind":"app""#));
    }

    #[test]
    fn a_legacy_pair_never_replaces_a_newer_credential() {
        // The pair is only worth moving while nothing else is stored. A start
        // where the Keychain refused the write leaves the keys behind, and by
        // the next one there may be a token — which `set_app` would clear.
        assert_eq!(legacy_plan(true, false), Legacy::Move);
        assert_eq!(legacy_plan(true, true), Legacy::Shed);
        // And with no keys there is nothing to do either way.
        assert_eq!(legacy_plan(false, false), Legacy::Leave);
        assert_eq!(legacy_plan(false, true), Legacy::Leave);
    }

    #[test]
    fn an_empty_value_is_refused_before_anything_is_cleared() {
        // `replace` deletes what is stored before it writes, so an empty value
        // has to be turned away here rather than by a disabled button.
        assert!(non_empty("", "token").is_err());
        assert!(non_empty("   ", "token").is_err());
        assert!(non_empty("tok", "token").is_ok());
    }

    #[test]
    fn legacy_pair_takes_only_a_complete_credential() {
        assert_eq!(
            legacy_pair(Some(&json!({ "discogs_key": "k", "discogs_secret": "s" }))),
            Some(("k".into(), "s".into()))
        );
        assert_eq!(legacy_pair(None), None);
        assert_eq!(legacy_pair(Some(&json!({}))), None);
        assert_eq!(legacy_pair(Some(&json!({ "discogs_key": "k" }))), None);
        assert_eq!(
            legacy_pair(Some(&json!({ "discogs_key": "k", "discogs_secret": "" }))),
            None
        );
        assert_eq!(
            legacy_pair(Some(&json!({ "discogs_key": null, "discogs_secret": "s" }))),
            None
        );
        // Whitespace is not a credential either, and it is what an emptied
        // input field leaves behind.
        assert_eq!(
            legacy_pair(Some(&json!({ "discogs_key": "  ", "discogs_secret": "s" }))),
            None
        );
    }
}
