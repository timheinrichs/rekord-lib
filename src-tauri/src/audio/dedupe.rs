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
/// Looser tolerance for the metadata tier: a foreign convert may shift the
/// length a bit more, but artist + normalized title must match exactly.
const METADATA_DURATION_TOLERANCE: f64 = 4.0;
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

// --- Metadata normalization (for the metadata match tier) ---

/// Lowercase, keep only alphanumerics, collapse the rest to single spaces.
/// "Alone (Paradise Version)" -> "alone paradise version".
fn norm_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() {
            out.push(c);
            prev_space = false;
        } else if !prev_space && !out.is_empty() {
            out.push(' ');
            prev_space = true;
        }
    }
    out.trim().to_string()
}

/// Normalized album name with a leading "Label - " prefix removed, e.g.
/// "Z Records - Italo House …" -> "italo house …".
fn norm_album(album: &str) -> String {
    if let Some(idx) = album.find(" - ") {
        let after = &album[idx + 3..];
        // Only strip when a substantial album name remains (avoid eating titles).
        if after.split_whitespace().count() >= 2 {
            return norm_text(after);
        }
    }
    norm_text(album)
}

/// Strips a leading track number ("01 ", "1. ", "07_") from a title fragment.
fn strip_leading_track_number(s: &str) -> String {
    let t = s.trim_start();
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 3 {
        return t.to_string();
    }
    let after = &t[digits.len()..];
    let trimmed = after.trim_start_matches([' ', '.', '_', '-']);
    if after.len() != trimmed.len() {
        trimmed.to_string()
    } else {
        t.to_string()
    }
}

/// Extracts the normalized "core" title from a possibly mangled title such as
/// "Artist - Album - 01 Title" -> "title", using the known artist/album tags to
/// drop leading segments. Falls back to the whole (normalized) title.
fn core_title(title: &str, artist: &str, album: &str) -> String {
    let na = norm_text(artist);
    let nal = norm_album(album);
    let segments: Vec<&str> = title.split(" - ").collect();
    let mut start = 0;
    // Drop leading segments equal to the artist or album (but keep the last one).
    while start < segments.len().saturating_sub(1) {
        let seg = norm_text(segments[start]);
        if !na.is_empty() && seg == na {
            start += 1;
        } else if !nal.is_empty() && (seg == nal || norm_album(segments[start]) == nal) {
            start += 1;
        } else {
            break;
        }
    }
    let rest = segments[start..].join(" - ");
    norm_text(&strip_leading_track_number(&rest))
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

    // Tier 0: metadata match. Group by (normalized artist, normalized core
    // title) and union files with a similar length. This catches tracks whose
    // titles were mangled by a foreign convert (e.g. "Artist - Album - 01 Title")
    // even when the acoustic fingerprint fails, because the artist tag and the
    // real title (at the end of the mangled string) still line up.
    let meta_key: Vec<Option<(String, String)>> = candidates
        .iter()
        .map(|c| {
            let artist = norm_text(
                c.album_artist
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .or(c.artist.as_deref())
                    .unwrap_or(""),
            );
            let title = core_title(
                c.title.as_deref().unwrap_or(&c.name),
                c.artist.as_deref().unwrap_or(""),
                c.album.as_deref().unwrap_or(""),
            );
            if artist.is_empty() || title.is_empty() {
                None
            } else {
                Some((artist, title))
            }
        })
        .collect();
    let mut meta_buckets: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (i, key) in meta_key.iter().enumerate() {
        if let Some(k) = key {
            meta_buckets.entry(k.clone()).or_default().push(i);
        }
    }
    for members in meta_buckets.values() {
        for a in 0..members.len() {
            for b in (a + 1)..members.len() {
                let (i, j) = (members[a], members[b]);
                if (candidates[i].duration_secs - candidates[j].duration_secs).abs()
                    <= METADATA_DURATION_TOLERANCE
                {
                    uf_union(&mut parent, i, j);
                }
            }
        }
    }

    // Tier 1: meaningfully equal name + equal length = duplicate, entirely
    // without a fingerprint (e.g. same title, different format). The remaining
    // equal-length pairs go into the audio check.
    let mut needs_fp = vec![false; n];
    let mut audio_pairs: Vec<(usize, usize)> = Vec::new();
    for &(i, j) in &pairs {
        // Already connected (via metadata or an earlier pair)? No fingerprint needed.
        if uf_find(&mut parent, i) == uf_find(&mut parent, j) {
            continue;
        }
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
            title: None,
            artist: None,
            album: None,
        }
    }

    #[test]
    fn norm_text_keeps_alphanumerics_only() {
        assert_eq!(norm_text("Alone (Paradise Version)"), "alone paradise version");
        assert_eq!(
            norm_text("Move Your Body (To The Sound) [Club Mix]"),
            "move your body to the sound club mix"
        );
    }

    #[test]
    fn norm_album_strips_label_prefix() {
        assert_eq!(
            norm_album("Z Records - Italo House compiled by Joey Negro"),
            "italo house compiled by joey negro"
        );
        assert_eq!(
            norm_album("Italo House compiled by Joey Negro"),
            "italo house compiled by joey negro"
        );
    }

    #[test]
    fn core_title_unmangles_the_screenshot_case() {
        // Clean vs. mangled title of the same track resolve to the same core.
        let clean = core_title(
            "Alone (Paradise Version)",
            "Don Carlos",
            "Italo House compiled by Joey Negro",
        );
        let mangled = core_title(
            "Don Carlos - Italo House compiled by Joey Negro - 01 Alone (Paradise Version)",
            "Don Carlos",
            "Z Records - Italo House compiled by Joey Negro",
        );
        assert_eq!(clean, "alone paradise version");
        assert_eq!(clean, mangled);
    }

    #[test]
    fn core_title_plain_title_without_separators() {
        assert_eq!(core_title("Just A Title", "Some Artist", "Some Album"), "just a title");
    }

    fn cand(id: &str, dur: f64, title: &str, artist: &str, album: &str) -> DupCandidate {
        DupCandidate {
            id: id.into(),
            path: format!("/lib/{id}.aiff"),
            name: title.into(),
            codec: "pcm_s16be".into(),
            container: "aiff".into(),
            sample_rate: 44_100,
            bits_per_sample: 16,
            lossless: true,
            duration_secs: dur,
            compatible: true,
            title: Some(title.into()),
            artist: Some(artist.into()),
            album_artist: Some(artist.into()),
            album: Some(album.into()),
        }
    }

    // The metadata-tier logic, mirrored as a pure helper for testing (the real
    // one is inlined in find_duplicates which needs an AppHandle).
    fn meta_matches(a: &DupCandidate, b: &DupCandidate) -> bool {
        let ka = (
            norm_text(a.album_artist.as_deref().or(a.artist.as_deref()).unwrap_or("")),
            core_title(
                a.title.as_deref().unwrap_or(&a.name),
                a.artist.as_deref().unwrap_or(""),
                a.album.as_deref().unwrap_or(""),
            ),
        );
        let kb = (
            norm_text(b.album_artist.as_deref().or(b.artist.as_deref()).unwrap_or("")),
            core_title(
                b.title.as_deref().unwrap_or(&b.name),
                b.artist.as_deref().unwrap_or(""),
                b.album.as_deref().unwrap_or(""),
            ),
        );
        !ka.0.is_empty()
            && !ka.1.is_empty()
            && ka == kb
            && (a.duration_secs - b.duration_secs).abs() <= METADATA_DURATION_TOLERANCE
    }

    #[test]
    fn metadata_tier_matches_clean_and_mangled() {
        let clean = cand("clean", 405.0, "Alone (Paradise Version)", "Don Carlos", "Italo House compiled by Joey Negro");
        let mangled = cand(
            "mangled",
            405.0,
            "Don Carlos - Italo House compiled by Joey Negro - 01 Alone (Paradise Version)",
            "Don Carlos",
            "Z Records - Italo House compiled by Joey Negro",
        );
        assert!(meta_matches(&clean, &mangled));
    }

    #[test]
    fn metadata_tier_rejects_different_artist_or_length() {
        let a = cand("a", 405.0, "Alone (Paradise Version)", "Don Carlos", "X");
        let other_artist = cand("b", 405.0, "Alone (Paradise Version)", "Someone Else", "X");
        let far_length = cand("c", 460.0, "Alone (Paradise Version)", "Don Carlos", "X");
        assert!(!meta_matches(&a, &other_artist));
        assert!(!meta_matches(&a, &far_length));
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
        title: c.title.clone(),
        artist: c.artist.clone(),
        album: c.album.clone(),
    }
}
