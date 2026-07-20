use crate::models::{AudioInfo, CompatIssue, CompatReport, Severity};

/// Sample rates supported on all CDJ/XDJ players.
const SUPPORTED_SAMPLE_RATES: [u32; 2] = [44_100, 48_000];

/// Lossy containers/codecs that play on all players.
fn is_universal_lossy(codec: &str) -> bool {
    matches!(codec, "mp3" | "aac")
}

/// Evaluates whether a file, as is, plays on all Pioneer CDJ/XDJ players.
///
/// The basis is the documented hardware limits: only uncompressed PCM
/// in AIFF/WAV, sample rate 44.1/48 kHz, 16/24-bit; MP3/AAC universal;
/// FLAC/ALAC only on newer players (CDJ-3000/NXS2).
pub fn evaluate(audio: &AudioInfo) -> CompatReport {
    let mut issues = Vec::new();

    // 1. Sample rate
    if audio.sample_rate == 0 {
        issues.push(CompatIssue {
            code: "SAMPLE_RATE_UNKNOWN".into(),
            message: "Sample rate could not be determined.".into(),
            severity: Severity::Warning,
        });
    } else if !SUPPORTED_SAMPLE_RATES.contains(&audio.sample_rate) {
        issues.push(CompatIssue {
            code: "SAMPLE_RATE".into(),
            message: format!(
                "{} Hz is not supported (E-8305). Required: 44,100 or 48,000 Hz.",
                audio.sample_rate
            ),
            severity: Severity::Error,
        });
    }

    let container = audio.container.to_lowercase();
    let codec = audio.codec.to_lowercase();
    let is_aiff = container.contains("aiff");
    let is_wav = container.contains("wav");
    let is_pcm = codec.starts_with("pcm_");

    // 2. AIFF/WAV must be uncompressed PCM (not AIFF-C).
    if (is_aiff || is_wav) && !is_pcm {
        issues.push(CompatIssue {
            code: "COMPRESSED_PCM_CONTAINER".into(),
            message: format!(
                "{} with codec \"{}\" (e.g. AIFF-C) will not play (E-8305). Only uncompressed PCM.",
                container, codec
            ),
            severity: Severity::Error,
        });
    }

    // 3. Bit depth: >24-bit or 32-bit float is not supported.
    if is_pcm && audio.bits_per_sample > 24 {
        issues.push(CompatIssue {
            code: "BIT_DEPTH".into(),
            message: format!(
                "{}-bit PCM is not supported. Required: 16- or 24-bit.",
                audio.bits_per_sample
            ),
            severity: Severity::Error,
        });
    }

    // 4. FLAC/ALAC only run on newer players.
    if codec == "flac" || codec == "alac" {
        issues.push(CompatIssue {
            code: "NEWER_PLAYERS_ONLY".into(),
            message: format!(
                "{} only runs on newer players (CDJ-3000/NXS2), not on all CDJ/XDJ.",
                codec.to_uppercase()
            ),
            severity: Severity::Warning,
        });
    }

    // 5. Fundamentally unsupported formats (neither universal lossy
    //    nor PCM nor FLAC/ALAC), e.g. ogg/opus/wma.
    let is_known_supported =
        is_pcm || is_universal_lossy(&codec) || codec == "flac" || codec == "alac";
    if !is_known_supported {
        issues.push(CompatIssue {
            code: "UNSUPPORTED_CODEC".into(),
            message: format!("Codec \"{}\" is not supported by CDJ/XDJ.", codec),
            severity: Severity::Error,
        });
    }

    let compatible = !issues.iter().any(|i| i.severity == Severity::Error);

    CompatReport { compatible, issues }
}
