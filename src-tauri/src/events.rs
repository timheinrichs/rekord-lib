//! The event log: what the app did and what failed.
//!
//! Everything in here used to be an `eprintln!`, which in a bundled `.app` goes
//! nowhere anyone will ever look. These are not the failures the user is
//! already staring at — a conversion that reports its own error — but the ones
//! the app survived quietly: a cache it could not read, rows it could not
//! persist, a tempo it detected but could not write. They explain the odd
//! behaviour that follows, and they are the difference between "it didn't work"
//! and a report someone can act on.

use tauri::{AppHandle, Emitter};

use crate::db;
use crate::models::EventLevel;

/// Records an event and prints it, so a `tauri dev` run still shows it inline.
///
/// Best effort by design: the log exists to explain a failure, so failing to
/// write it must never turn a survivable problem into a fatal one. Callers get
/// no result back and nothing to handle.
pub fn record(
    app: &AppHandle,
    level: EventLevel,
    source: &str,
    message: &str,
    detail: Option<&str>,
) {
    match detail {
        Some(detail) => eprintln!("[{}] {source}: {message} — {detail}", level.as_str()),
        None => eprintln!("[{}] {source}: {message}", level.as_str()),
    }

    let stored = db::require(app).and_then(|database| {
        let mut conn = database.conn()?;
        Ok(db::push_event(&mut conn, level, source, message, detail)?)
    });
    match stored {
        // Whatever is open — the panel, the badge — follows without polling.
        Ok(_) => {
            let _ = app.emit("events://new", ());
        }
        // Printed rather than recorded: the log is exactly what is broken here.
        Err(e) => eprintln!("Could not record the event above: {e}"),
    }
}

/// Something the app worked around. The library is intact, but a run may have
/// been slower or less complete than it looks.
pub fn warn(app: &AppHandle, source: &str, message: &str, detail: Option<&str>) {
    record(app, EventLevel::Warn, source, message, detail);
}

/// Something the app could not do at all.
pub fn error(app: &AppHandle, source: &str, message: &str, detail: Option<&str>) {
    record(app, EventLevel::Error, source, message, detail);
}
