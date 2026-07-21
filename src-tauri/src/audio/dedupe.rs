use std::collections::HashMap;
use std::sync::atomic::Ordering;

use rusty_chromaprint::{match_fingerprints, Configuration};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::fingerprint;
use crate::jobs::DedupeState;
use crate::models::{DupCandidate, DuplicateFile, DuplicateGroup};

// Criteria for a duplicate match. Measured against real data:
// - the same recording: score ~3.3, coverage ~1.0
// - different tracks: usually no segment; weak random partial matches
//   (e.g. the same beat) have low coverage (~0.1). Exactly those chained
//   unrelated tracks into huge groups via union-find.
/// Upper score bound of a match segment (0 = identical).
const AUDIO_SCORE_MAX: f64 = 5.0;
/// Minimum coverage: fraction of the shorter fingerprint that the segment covers.
const COVERAGE_MIN: f64 = 0.7;
/// Name similarity (word overlap 0..1) above which name+length alone make a
/// duplicate (no fingerprint needed) - e.g. same name, different format.
const NAME_HIGH: f64 = 0.85;
/// Name similarity that must additionally confirm an audio match.
const NAME_MIN: f64 = 0.5;
/// Nearly identical audio counts as a duplicate even without name similarity.
const IDENTICAL_SCORE: f64 = 3.0;
const IDENTICAL_COVERAGE: f64 = 0.9;
/// File extension tokens ignored during the name similarity check.
const EXT_TOKENS: &[&str] = &[
    "aiff", "aif", "wav", "flac", "alac", "m4a", "mp3", "aac", "ogg", "opus", "wma",
];
/// Play duration tolerance (seconds) for the pre-grouping. Duplicates have
/// (even across formats) nearly identical length - keeping this tight saves a
/// massive number of fingerprints in large libraries.
const DURATION_TOLERANCE: f64 = 1.0;
/// How many files are fingerprinted in parallel (one ffmpeg process each).
const FP_CONCURRENCY: usize = 8;

/// Progress of the duplicate search (streamed to the frontend).
#[derive(Clone, Serialize)]
pub struct DedupeProgress {
    pub generation: u64,
    pub done: usize,
    pub total: usize,
    pub stage: String,
    pub running: bool,
}

fn emit(app: &AppHandle, generation: u64, done: usize, total: usize, stage: &str, running: bool) {
    // Also mirror the progress in the shared state (for reattach after reload).
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

/// Best match segment as (score, coverage 0..1 of the shorter fingerprint).
fn best_match(fp1: &[u32], fp2: &[u32], config: &Configuration) -> Option<(f64, f64)> {
    let segments = match_fingerprints(fp1, fp2, config).ok()?;
    let min_len = fp1.len().min(fp2.len()).max(1) as f64;
    segments
        .iter()
        .map(|s| (s.score, s.items_count as f64 / min_len))
        .min_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal))
}

type Tokens = std::collections::HashSet<String>;

/// Word tokens of a name (lowercase, without single-character, pure-number and
/// file-extension tokens). This makes "Song.aiff" and "Song.wav" name-equal.
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

/// Jaccard similarity of two token sets (intersection/union, 0..1).
/// Deliberately not the overlap coefficient: otherwise a subset (e.g.
/// "Version I", whose "I" is dropped as a single-character token) would count as
/// a 100% match and wrongly chain different versions together.
fn token_overlap(a: &Tokens, b: &Tokens) -> f64 {
    let union = a.union(b).count();
    if union == 0 {
        return 0.0;
    }
    a.intersection(b).count() as f64 / union as f64
}

/// Do two files count as the same track based on the audio? A strong match
/// (score + coverage) AND a similar name - or nearly identical audio
/// (then the audio match alone suffices, even with a different name).
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

// --- Union-find for merging connected duplicates ---

fn uf_find(parent: &mut [usize], mut x: usize) -> usize {
    while parent[x] != x {
        parent[x] = parent[parent[x]]; // path compression
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

/// Highest quality first: lossless > lossy, then sample rate,
/// bit depth and file size.
fn quality_key(f: &DuplicateFile) -> (bool, u32, u32, u64) {
    (f.lossless, f.sample_rate, f.bits_per_sample, f.size_bytes)
}

/// Searches for duplicates across all formats/file names: first pre-group by
/// length, then confirm via acoustic fingerprint.
pub async fn find_duplicates(
    app: &AppHandle,
    candidates: Vec<DupCandidate>,
    generation: u64,
) -> (Vec<DuplicateGroup>, bool) {
    let n = candidates.len();
    if n < 2 {
        return (vec![], false);
    }

    // Order sorted by duration.
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| {
        candidates[a]
            .duration_secs
            .total_cmp(&candidates[b].duration_secs)
    });

    // Word tokens per file (for name similarity).
    let tokens: Vec<Tokens> = candidates.iter().map(|c| name_tokens(&c.name)).collect();

    // Candidate pairs with similar length (within the duration-sorted window).
    let mut pairs: Vec<(usize, usize)> = Vec::new();
    for oi in 0..n {
        let i = order[oi];
        for oj in (oi + 1)..n {
            let j = order[oj];
            if candidates[j].duration_secs - candidates[i].duration_secs > DURATION_TOLERANCE {
                break; // sorted -> everything from here on is too far apart
            }
            pairs.push((i, j));
        }
    }

    let mut parent: Vec<usize> = (0..n).collect();

    // Tier 1: meaningfully equal name + equal length = duplicate, entirely
    // without a fingerprint (e.g. same title, different format). The remaining
    // equal-length pairs go into the audio check.
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

    // Compute fingerprints (the expensive part) - in parallel with progress.
    // Only needed for files that have an equal-length but differently named file
    // (Tier-1 matches need no fingerprint).
    let to_fp: Vec<usize> = (0..n).filter(|&i| needs_fp[i]).collect();
    let total = to_fp.len();
    let mut fps: Vec<Option<Vec<u32>>> = vec![None; n];
    let mut done = 0usize;
    emit(app, generation, 0, total, "Analyzing", true);
    for chunk in to_fp.chunks(FP_CONCURRENCY) {
        if app.state::<DedupeState>().cancel.load(Ordering::SeqCst) {
            return (vec![], true);
        }
        // Decode/fingerprint the whole chunk at once.
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
            emit(app, generation, done, total, "Analyzing", true);
        }
    }
    emit(app, generation, total, total, "Comparing", true);

    // Tier 2: check equal-length but differently named pairs via audio.
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

    // Combine components with >= 2 members into groups.
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
        // Suggestion: keep the highest quality.
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

    // Stable output: sort groups by ID.
    groups.sort_by(|a, b| a.id.cmp(&b.id));
    (groups, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dfile(id: &str, lossless: bool, sr: u32, bits: u32, size: u64) -> DuplicateFile {
        DuplicateFile {
            id: id.into(),
            path: id.into(),
            file_name: id.into(),
            codec: "x".into(),
            container: "x".into(),
            sample_rate: sr,
            bits_per_sample: bits,
            lossless,
            duration_secs: 100.0,
            compatible: true,
            size_bytes: size,
        }
    }

    #[test]
    fn name_tokens_drops_extension_single_char_and_numbers() {
        let a = name_tokens("01 - Artist - Song Title.aiff");
        assert!(a.contains("artist") && a.contains("song") && a.contains("title"));
        assert!(!a.contains("aiff"), "extension token must be ignored");
        assert!(!a.contains("01"), "pure-number token must be ignored");
    }

    #[test]
    fn name_tokens_equal_across_formats() {
        assert_eq!(name_tokens("Song.aiff"), name_tokens("Song.wav"));
    }

    #[test]
    fn token_overlap_is_jaccard() {
        let a = name_tokens("alpha beta gamma");
        let b = name_tokens("alpha beta delta");
        // intersection 2 (alpha,beta), union 4 -> 0.5
        assert!((token_overlap(&a, &b) - 0.5).abs() < 1e-9);
        assert_eq!(token_overlap(&a, &a), 1.0);
    }

    #[test]
    fn token_overlap_empty_sets_zero() {
        let empty: Tokens = Tokens::new();
        assert_eq!(token_overlap(&empty, &empty), 0.0);
    }

    #[test]
    fn quality_key_prefers_lossless_then_rate_bits_size() {
        let lossless = dfile("a", true, 44_100, 16, 1000);
        let lossy = dfile("b", false, 48_000, 24, 9999);
        assert!(quality_key(&lossless) > quality_key(&lossy));

        let hi = dfile("c", true, 96_000, 24, 10);
        let lo = dfile("d", true, 44_100, 16, 10);
        assert!(quality_key(&hi) > quality_key(&lo));
    }

    #[test]
    fn union_find_merges_components() {
        let mut parent: Vec<usize> = (0..5).collect();
        uf_union(&mut parent, 0, 1);
        uf_union(&mut parent, 1, 2);
        uf_union(&mut parent, 3, 4);
        assert_eq!(uf_find(&mut parent, 0), uf_find(&mut parent, 2));
        assert_eq!(uf_find(&mut parent, 3), uf_find(&mut parent, 4));
        assert_ne!(uf_find(&mut parent, 0), uf_find(&mut parent, 3));
    }
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
