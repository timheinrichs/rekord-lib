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
use crate::models::{EventLevel, EventNotice};

/// Writes the row, prints it, and tells the frontend what it wrote.
///
/// Best effort by design: the log exists to explain a failure, so failing to
/// write it must never turn a survivable problem into a fatal one. Callers get
/// no result back and nothing to handle.
///
/// The emit sits on the `Ok` arm on purpose, and that placement is now load
/// bearing. A transient message in the UI is this notice drawn on its way past,
/// so nothing can be shown that was not first written to the table — not by
/// convention but by shape, because there is no other way to reach the emit.
fn store(
    app: &AppHandle,
    level: EventLevel,
    source: &str,
    message: &str,
    detail: Option<&str>,
    announce: bool,
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
        // Whatever is open — the panel, the badge, a message on screen —
        // follows without polling.
        Ok(id) => {
            let _ = app.emit(
                "events://new",
                EventNotice {
                    id,
                    level,
                    message: message.to_string(),
                    announce,
                },
            );
        }
        // Printed rather than recorded: the log is exactly what is broken here.
        Err(e) => eprintln!("Could not record the event above: {e}"),
    }
}

/// Records an event and prints it, so a `tauri dev` run still shows it inline.
///
/// Quiet: the log and the badge follow, nothing is drawn. This is the right
/// call for everything the app survived without the user asking it to do
/// anything — and for everything it collects per file.
pub fn record(
    app: &AppHandle,
    level: EventLevel,
    source: &str,
    message: &str,
    detail: Option<&str>,
) {
    store(app, level, source, message, detail, false);
}

/// Records an event *and* asks for it to be shown on its way past.
///
/// One call, one string, one row: the transient message and the log entry
/// cannot disagree about what happened, because there is nothing to keep in
/// step. The bar for reaching for this rather than `record`: it is a main
/// action's own answer, and it happens once per run rather than once per file.
pub fn announce(
    app: &AppHandle,
    level: EventLevel,
    source: &str,
    message: &str,
    detail: Option<&str>,
) {
    store(app, level, source, message, detail, true);
}

/// "1 track" / "12 tracks".
///
/// Small, and here rather than inlined because these messages are read by
/// someone who just did the thing: `1 track(s)` is the shape of a sentence
/// nobody wrote, and it would have appeared in four of them.
pub fn tracks(n: usize) -> String {
    if n == 1 {
        "1 track".to_string()
    } else {
        format!("{n} tracks")
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
