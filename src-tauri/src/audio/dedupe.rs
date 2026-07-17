use std::collections::HashMap;
use std::sync::atomic::Ordering;

use rusty_chromaprint::{match_fingerprints, Configuration};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::fingerprint;
use crate::jobs::DedupeState;
use crate::models::{DupCandidate, DuplicateFile, DuplicateGroup};

// Kriterien für einen Duplikat-Match. Gemessen an echten Daten:
// - dieselbe Aufnahme: Score ~3.3, Abdeckung ~1.0
// - verschiedene Tracks: meist kein Segment; schwache Zufalls-Teilmatches
//   (z. B. gleicher Beat) haben niedrige Abdeckung (~0.1). Genau diese haben
//   über Union-Find fremde Tracks zu Riesengruppen verkettet.
/// Score-Obergrenze eines Match-Segments (0 = identisch).
const AUDIO_SCORE_MAX: f64 = 5.0;
/// Mindest-Abdeckung: Anteil des kürzeren Fingerabdrucks, den das Segment abdeckt.
const COVERAGE_MIN: f64 = 0.7;
/// Namensähnlichkeit (Wort-Overlap 0..1), ab der Name+Länge allein ein Duplikat
/// ergeben (kein Fingerprint nötig) – z. B. gleicher Name, anderes Format.
const NAME_HIGH: f64 = 0.85;
/// Namensähnlichkeit, die ein Audio-Match zusätzlich bestätigen muss.
const NAME_MIN: f64 = 0.5;
/// Nahezu identisches Audio gilt auch ohne Namensähnlichkeit als Duplikat.
const IDENTICAL_SCORE: f64 = 3.0;
const IDENTICAL_COVERAGE: f64 = 0.9;
/// Dateiendungs-Tokens, die bei der Namensähnlichkeit ignoriert werden.
const EXT_TOKENS: &[&str] = &[
    "aiff", "aif", "wav", "flac", "alac", "m4a", "mp3", "aac", "ogg", "opus", "wma",
];
/// Toleranz der Spieldauer (Sekunden) für die Vorgruppierung. Duplikate haben
/// (auch über Formate hinweg) nahezu identische Länge – eng halten spart massiv
/// Fingerprints in großen Libraries.
const DURATION_TOLERANCE: f64 = 1.0;
/// Wie viele Dateien parallel fingerprintet werden (je ein ffmpeg-Prozess).
const FP_CONCURRENCY: usize = 8;

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

/// Bestes Match-Segment als (Score, Abdeckung 0..1 des kürzeren Fingerabdrucks).
fn best_match(fp1: &[u32], fp2: &[u32], config: &Configuration) -> Option<(f64, f64)> {
    let segments = match_fingerprints(fp1, fp2, config).ok()?;
    let min_len = fp1.len().min(fp2.len()).max(1) as f64;
    segments
        .iter()
        .map(|s| (s.score, s.items_count as f64 / min_len))
        .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
}

type Tokens = std::collections::HashSet<String>;

/// Wort-Tokens eines Namens (klein, ohne 1-Zeichen-, reine-Zahlen- und
/// Dateiendungs-Tokens). So sind "Song.aiff" und "Song.wav" namensgleich.
fn name_tokens(name: &str) -> Tokens {
    name.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| {
            t.len() >= 2
                && !t.chars().all(|c| c.is_numeric())
                && !EXT_TOKENS.contains(t)
        })
        .map(|t| t.to_string())
        .collect()
}

/// Jaccard-Ähnlichkeit zweier Token-Mengen (Schnitt/Vereinigung, 0..1).
/// Bewusst nicht der Overlap-Koeffizient: sonst gilt eine Teilmenge (z. B.
/// "Version I", dessen "I" als 1-Zeichen-Token wegfällt) als 100%-Treffer und
/// verkettet verschiedene Versionen fälschlich.
fn token_overlap(a: &Tokens, b: &Tokens) -> f64 {
    let union = a.union(b).count();
    if union == 0 {
        return 0.0;
    }
    a.intersection(b).count() as f64 / union as f64
}

/// Gelten zwei Dateien anhand des Audios als derselbe Track? Starker Match
/// (Score + Abdeckung) UND ähnlicher Name – oder nahezu identisches Audio
/// (dann reicht der Audio-Match allein, auch bei anderem Namen).
fn audio_duplicate(
    fp1: &[u32],
    fp2: &[u32],
    tok1: &Tokens,
    tok2: &Tokens,
    config: &Configuration,
) -> bool {
    let Some((score, coverage)) = best_match(fp1, fp2, config) else {
        return false;
    };
    if score > AUDIO_SCORE_MAX || coverage < COVERAGE_MIN {
        return false;
    }
    let identical = score <= IDENTICAL_SCORE && coverage >= IDENTICAL_COVERAGE;
    identical || token_overlap(tok1, tok2) >= NAME_MIN
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

    // Wort-Tokens je Datei (für Namensähnlichkeit).
    let tokens: Vec<Tokens> = candidates.iter().map(|c| name_tokens(&c.name)).collect();

    // Kandidaten-Paare mit ähnlicher Länge (im nach Dauer sortierten Fenster).
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for oi in 0..n {
        let i = order[oi];
        for oj in (oi + 1)..n {
            let j = order[oj];
            if candidates[j].duration_secs - candidates[i].duration_secs > DURATION_TOLERANCE {
                break; // sortiert -> ab hier alle zu weit entfernt
            }
            pairs.push((i, j));
        }
    }

    let mut parent: Vec<usize> = (0..n).collect();

    // Tier 1: aussagekräftig gleicher Name + gleiche Länge = Duplikat, ganz ohne
    // Fingerprint (z. B. gleicher Titel, anderes Format). Übrige gleich-lange
    // Paare kommen in die Audio-Prüfung.
    let mut needs_fp = vec![false; n];
    let mut audio_pairs: Vec<(usize, usize)> = Vec::new();
    for &(i, j) in &pairs {
        let inter = tokens[i].intersection(&tokens[j]).count();
        if inter >= 2 && token_overlap(&tokens[i], &tokens[j]) >= NAME_HIGH {
            uf_union(&mut parent, i, j);
        } else {
            needs_fp[i] = true;
            needs_fp[j] = true;
            audio_pairs.push((i, j));
        }
    }

    // Fingerabdrücke berechnen (der teure Teil) – parallel mit Fortschritt.
    // Nur für Dateien nötig, die eine gleich lange, aber anders benannte Datei
    // haben (Tier-1-Treffer brauchen keinen Fingerprint).
    let to_fp: Vec<usize> = (0..n).filter(|&i| needs_fp[i]).collect();
    let total = to_fp.len();
    let mut fps: Vec<Option<Vec<u32>>> = vec![None; n];
    let mut done = 0usize;
    emit(app, generation, 0, total, "Analysiere", true);
    for chunk in to_fp.chunks(FP_CONCURRENCY) {
        if app.state::<DedupeState>().cancel.load(Ordering::SeqCst) {
            return (vec![], true);
        }
        // Ganzen Chunk gleichzeitig dekodieren/fingerprinten.
        let handles: Vec<(usize, _)> = chunk
            .iter()
            .map(|&i| {
                let app2 = app.clone();
                let path = candidates[i].path.clone();
                (
                    i,
                    tauri::async_runtime::spawn(async move {
                        fingerprint::fingerprint(&app2, &path).await.ok()
                    }),
                )
            })
            .collect();
        for (i, handle) in handles {
            if let Ok(Some(fp)) = handle.await {
                fps[i] = Some(fp);
            }
            done += 1;
            emit(app, generation, done, total, "Analysiere", true);
        }
    }
    emit(app, generation, total, total, "Vergleiche", true);

    // Tier 2: gleich lange, aber anders benannte Paare per Audio prüfen.
    let config = fingerprint::config();
    for &(i, j) in &audio_pairs {
        if app.state::<DedupeState>().cancel.load(Ordering::SeqCst) {
            return (vec![], true);
        }
        let (Some(fi), Some(fj)) = (fps[i].as_ref(), fps[j].as_ref()) else {
            continue;
        };
        if audio_duplicate(fi, fj, &tokens[i], &tokens[j], &config) {
            uf_union(&mut parent, i, j);
        }
    }

    // Komponenten mit >= 2 Mitgliedern zu Gruppen zusammenfassen.
    let mut groups_map: HashMap<usize, Vec<usize>> = HashMap::new();
    for i in 0..n {
        let root = uf_find(&mut parent, i);
        groups_map.entry(root).or_default().push(i);
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
