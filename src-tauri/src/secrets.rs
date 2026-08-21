//! The one real secret the app holds, kept where secrets belong.
//!
//! The Discogs consumer key and secret used to sit in plaintext in
//! `rekord-lib.json` in the app data folder, and travelled from the frontend to
//! the backend as arguments on every suggestion request. They now live in the
//! macOS Keychain, and the frontend never sees the secret again: it writes it
//! once and asks only whether one is stored.
//!
//! **It fails closed.** When the Keychain refuses — the user denied access, or
//! an ad-hoc-signed update no longer matches the item's ACL — nothing falls back
//! to the JSON store. Settings says the credentials are unavailable and asks for
//! them again, and until then Discogs suggestions are simply empty, which is
//! what `metadata::suggest` already does without credentials. MusicBrainz keeps
//! working either way.

use keyring::Entry;
use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_store::StoreExt;

/// The two halves of a Discogs app credential, as one Keychain item each.
const KEY_ACCOUNT: &str = "discogs-consumer-key";
const SECRET_ACCOUNT: &str = "discogs-consumer-secret";

/// Store file and the keys the credentials used to live under.
const STORE_FILE: &str = "rekord-lib.json";
const SETTINGS_KEY: &str = "settings";
const LEGACY_KEY: &str = "discogs_key";
const LEGACY_SECRET: &str = "discogs_secret";

/// What settings needs to know: whether there is a credential, without ever
/// being told what it is.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct DiscogsStatus {
    /// A key and a secret are stored and readable.
    pub stored: bool,
    /// The Keychain itself could not be used — see the module comment.
    pub unavailable: bool,
    /// The consumer key, which is not the secret half and is worth showing so
    /// the user can tell which app's credentials are in there.
    pub key: Option<String>,
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

/// Reads both halves. `None` when either is missing or the Keychain is closed —
/// half a credential is not a credential.
pub fn discogs(app: &AppHandle) -> Option<(String, String)> {
    let key = entry(app, KEY_ACCOUNT).ok()?.get_password().ok()?;
    let secret = entry(app, SECRET_ACCOUNT).ok()?.get_password().ok()?;
    if key.is_empty() || secret.is_empty() {
        return None;
    }
    Some((key, secret))
}

/// Stores both halves, replacing whatever was there.
///
/// Both or neither: a key stored without its secret is not a credential, and it
/// would sit there unused and unshown, because `status` reports a pair or
/// nothing.
pub fn set_discogs(app: &AppHandle, key: &str, secret: &str) -> keyring::Result<()> {
    entry(app, KEY_ACCOUNT)?.set_password(key)?;
    if let Err(e) = entry(app, SECRET_ACCOUNT).and_then(|e| e.set_password(secret)) {
        let _ = clear_discogs(app);
        return Err(e);
    }
    Ok(())
}

/// Removes both halves. A missing item is not an error — the end state is what
/// was asked for either way.
pub fn clear_discogs(app: &AppHandle) -> keyring::Result<()> {
    for account in [KEY_ACCOUNT, SECRET_ACCOUNT] {
        match entry(app, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(e) => return Err(e),
        }
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
    let (Ok(key), Ok(secret)) = (read(app, KEY_ACCOUNT), read(app, SECRET_ACCOUNT)) else {
        return DiscogsStatus {
            unavailable: true,
            ..DiscogsStatus::default()
        };
    };
    DiscogsStatus {
        stored: key.is_some() && secret.is_some(),
        unavailable: false,
        key,
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
    if !map.contains_key(LEGACY_KEY) && !map.contains_key(LEGACY_SECRET) {
        return;
    }
    if let Some((key, secret)) = legacy_pair(Some(&settings)) {
        if let Err(e) = set_discogs(app, &key, &secret) {
            eprintln!("Could not move the Discogs credentials into the Keychain: {e}");
            return;
        }
        println!("Discogs credentials moved into the Keychain");
    }
    let map = settings.as_object_mut().expect("checked above");
    map.remove(LEGACY_KEY);
    map.remove(LEGACY_SECRET);
    store.set(SETTINGS_KEY, settings);
    if let Err(e) = store.save() {
        eprintln!("Could not remove the Discogs credentials from the store: {e}");
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
