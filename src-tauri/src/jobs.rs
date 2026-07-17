//! Gemeinsamer Zustand für die langlaufenden Hintergrund-Jobs (Scan, Dedupe).
//! Beide laufen als Singleton: es gibt immer höchstens einen aktiven Lauf, der
//! im Hintergrund weiterläuft (unabhängig von Reload/Fenster) und abgebrochen
//! werden kann. Ergebnisse werden per Event ausgeliefert.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize};
use std::sync::Mutex;

use crate::models::DuplicateGroup;

/// Zustand des Library-Scans.
#[derive(Default)]
pub struct ScanState {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    pub generation: AtomicU64,
    pub done: AtomicUsize,
    pub total: AtomicUsize,
}

/// Zustand der Duplikatsuche (inkl. Ergebnis-Cache für Reattach).
#[derive(Default)]
pub struct DedupeState {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    pub generation: AtomicU64,
    pub done: AtomicUsize,
    pub total: AtomicUsize,
    pub stage: Mutex<String>,
    /// Ergebnis des letzten abgeschlossenen Laufs (für erneutes Öffnen).
    pub result: Mutex<Option<Vec<DuplicateGroup>>>,
}
