//! Shared state for the long-running background jobs (scan, dedupe).
//! Both run as singletons: there is always at most one active run, which
//! keeps running in the background (independent of reload/window) and can be
//! cancelled. Results are delivered via events.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};
use std::sync::Mutex;

use crate::models::DuplicateGroup;

/// State of the library scan.
#[derive(Default)]
pub struct ScanState {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    pub generation: AtomicU64,
    pub done: AtomicUsize,
    pub total: AtomicUsize,
}

/// State of the duplicate search (including a result cache for reattach).
#[derive(Default)]
pub struct DedupeState {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    pub generation: AtomicU64,
    pub done: AtomicUsize,
    pub total: AtomicUsize,
    pub stage: Mutex<String>,
    /// Result of the last completed run (for reopening).
    pub result: Mutex<Option<Vec<DuplicateGroup>>>,
}
