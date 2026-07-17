use std::collections::HashMap;
use std::sync::atomic::Ordering;

use rusty_chromaprint::{match_fingerprints, Configuration};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::fingerprint;
use crate::jobs::DedupeState;
use crate::models::{DupCandidate, DuplicateFile, DuplicateGroup};

/// Score-Obergrenze (0 = identisch, größer = unähnlicher), ab der ein Segment
/// als Übereinstimmung gilt. Echte Treffer liegen deutlich darunter (< 1).
const DUP_SCORE_MAX: f64 = 3.0;
/// Mindestdauer (Sekunden) eines übereinstimmenden Segments.
const DUP_MIN_SECS: f32 = 12.0;
/// Toleranz der Spieldauer (Sekunden) für die Vorgruppierung.
const DURATION_TOLERANCE: f64 = 3.0;

/// Fortschritt der Duplikatsuche (an das Frontend gestreamt).
#[derive(Clone, Serialize)]
pub struct DedupeProgress {
    pub generation: u64,
    pub done: usize,
    pub total: usize,
    pub stage: String,
    pub running: bool,
}

fn emit(app: &AppHandle, generation: u64, done: usize, total: usize, stage: &str, running: bool) {
    // Fortschritt auch im geteilten State spiegeln (für Reattach nach Reload).
    let state = app.state::<DedupeState>();
    state.done.store(done, Ordering::SeqCst);
    state.total.store(total, Ordering::SeqCst);
    if let Ok(mut s) = state.stage.lock() {
        *s = stage.to_string();
    }
    let _ = app.emit(
        "dedupe://progress",
        DedupeProgress {
            generation,
            done,
            total,
            stage: stage.to_string(),
            running,
        },
    );
}

/// Gelten zwei Fingerabdrücke als derselbe Track?
fn is_duplicate(fp1: &[u32], fp2: &[u32], config: &Configuration) -> bool {
    match match_fingerprints(fp1, fp2, config) {
        Ok(segments) => segments
            .iter()
            .any(|s| s.score <= DUP_SCORE_MAX && s.duration(config) >= DUP_MIN_SECS),
        Err(_) => false,
    }
}

// --- Union-Find zum Zusammenfassen zusammenhängender Duplikate ---

fn uf_find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]]; // Pfadverkürzung
        x = parent[x];
    }
    x
}

fn uf_union(parent: &mut [usize], a: usize, b: usize) {
    let ra = uf_find(parent, a);
    let rb = uf_find(parent, b);
    if ra != rb {
        parent[ra] = rb;
    }
}

/// Höchste Qualität zuerst: verlustfrei > verlustbehaftet, dann Samplerate,
/// Bit-Tiefe und Dateigröße.
fn quality_key(f: &DuplicateFile) -> (bool, u32, u32, u64) {
    (f.lossless, f.sample_rate, f.bits_per_sample, f.size_bytes)
}

/// Sucht Duplikate über alle Formate/Dateinamen: erst nach Länge vorgruppieren,
/// dann per akustischem Fingerabdruck bestätigen.
pub async fn find_duplicates(
    app: &AppHandle,
    candidates: Vec<DupCandidate>,
    generation: u64,
) -> (Vec<DuplicateGroup>, bool) {
    let n = candidates.len();
    if n < 2 {
        return (vec![], false);
    }

    // Nach Dauer sortierte Reihenfolge.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        candidates[a]
            .duration_secs
            .total_cmp(&candidates[b].duration_secs)
    });

    // Nur Dateien fingerprinten, die mit mindestens einer anderen eine ähnliche
    // Dauer teilen (Dateien mit einzigartiger Länge können keine Duplikate sein).
    let mut needs_fp = vec![false; n];
    for oi in 0..n {
        let i = order[oi];
        if oi + 1 < n {
            let j = order[oi + 1];
            if (candidates[j].duration_secs - candidates[i].duration_secs).abs()
                <= DURATION_TOLERANCE
            {
                needs_fp[i] = true;
                needs_fp[j] = true;
            }
        }
    }

    // Fingerabdrücke berechnen (der teure Teil) mit Fortschritt.
    let to_fp: Vec<usize> = (0..n).filter(|&i| needs_fp[i]).collect();
    let total = to_fp.len();
    let mut fps: Vec<Option<Vec<u32>>> = vec![None; n];
    for (k, &i) in to_fp.iter().enumerate() {
        if app.state::<DedupeState>().cancel.load(Ordering::SeqCst) {
            return (vec![], true);
        }
        emit(app, generation, k, total, "Analysiere", true);
        if let Ok(fp) = fingerprint::fingerprint(app, &candidates[i].path).await {
            fps[i] = Some(fp);
        }
    }
    emit(app, generation, total, total, "Vergleiche", true);

    // Innerhalb der Dauer-Toleranz paarweise vergleichen und verbinden.
    let config = fingerprint::config();
    let mut parent: Vec<usize> = (0..n).collect();
    for oi in 0..n {
        if app.state::<DedupeState>().cancel.load(Ordering::SeqCst) {
            return (vec![], true);
        }
        let i = order[oi];
        let Some(fi) = fps[i].as_ref() else { continue };
        for oj in (oi + 1)..n {
            let j = order[oj];
            if candidates[j].duration_secs - candidates[i].duration_secs > DURATION_TOLERANCE {
                break; // sortiert -> ab hier alle zu weit entfernt
            }
            let Some(fj) = fps[j].as_ref() else { continue };
            if is_duplicate(fi, fj, &config) {
                uf_union(&mut parent, i, j);
            }
        }
    }

    // Komponenten mit >= 2 Mitgliedern zu Gruppen zusammenfassen.
    let mut groups_map: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        if fps[i].is_some() {
            let root = uf_find(&mut parent, i);
            groups_map.entry(root).or_default().push(i);
        }
    }

    let mut groups: Vec<DuplicateGroup> = Vec::new();
    for (_root, members) in groups_map {
        if members.len() < 2 {
            continue;
        }
        let files: Vec<DuplicateFile> = members
            .iter()
            .map(|&i| to_duplicate_file(&candidates[i]))
            .collect();
        // Vorschlag: höchste Qualität behalten.
        let keep_id = files
            .iter()
            .max_by(|a, b| quality_key(a).cmp(&quality_key(b)))
            .map(|f| f.id.clone())
            .unwrap_or_default();
        let id = files
            .iter()
            .map(|f| f.id.as_str())
            .min()
            .unwrap_or("")
            .to_string();
        groups.push(DuplicateGroup {
            id,
            files,
            keep_id,
        });
    }

    // Stabile Ausgabe: Gruppen nach ID sortieren.
    groups.sort_by(|a, b| a.id.cmp(&b.id));
    (groups, false)
}

fn to_duplicate_file(c: &DupCandidate) -> DuplicateFile {
    let file_name = std::path::Path::new(&c.path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&c.path)
        .to_string();
    let size_bytes = std::fs::metadata(&c.path).map(|m| m.len()).unwrap_or(0);
    DuplicateFile {
        id: c.id.clone(),
        path: c.path.clone(),
        file_name,
        codec: c.codec.clone(),
        container: c.container.clone(),
        sample_rate: c.sample_rate,
        bits_per_sample: c.bits_per_sample,
        lossless: c.lossless,
        duration_secs: c.duration_secs,
        compatible: c.compatible,
        size_bytes,
    }
}
