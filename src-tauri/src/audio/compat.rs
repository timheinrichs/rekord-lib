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

#[cfg(test)]
mod tests {
    use super::*;

    fn audio(container: &str, codec: &str, sample_rate: u32, bits: u32) -> AudioInfo {
        AudioInfo {
            container: container.into(),
            codec: codec.into(),
            sample_rate,
            bits_per_sample: bits,
            channels: 2,
            duration_secs: 180.0,
            lossless: codec.starts_with("pcm_") || codec == "flac" || codec == "alac",
        }
    }

    fn has(report: &CompatReport, code: &str) -> bool {
        report.issues.iter().any(|i| i.code == code)
    }

    #[test]
    fn clean_aiff_pcm_is_compatible() {
        let r = evaluate(&audio("aiff", "pcm_s16be", 44_100, 16));
        assert!(r.compatible);
        assert!(r.issues.is_empty());
    }

    #[test]
    fn universal_lossy_is_compatible() {
        assert!(evaluate(&audio("mp3", "mp3", 44_100, 0)).compatible);
        assert!(evaluate(&audio("mov,mp4,m4a", "aac", 48_000, 0)).compatible);
    }

    #[test]
    fn unsupported_sample_rate_is_error() {
        let r = evaluate(&audio("wav", "pcm_s16le", 96_000, 16));
        assert!(!r.compatible);
        assert!(has(&r, "SAMPLE_RATE"));
    }

    #[test]
    fn zero_sample_rate_is_warning_not_error() {
        let r = evaluate(&audio("aiff", "pcm_s16be", 0, 16));
        assert!(has(&r, "SAMPLE_RATE_UNKNOWN"));
        assert!(r.compatible, "unknown sample rate is only a warning");
    }

    #[test]
    fn compressed_pcm_container_is_error() {
        // AIFF-C style: aiff container but a non-PCM codec.
        let r = evaluate(&audio("aiff", "sowt", 44_100, 16));
        assert!(!r.compatible);
        assert!(has(&r, "COMPRESSED_PCM_CONTAINER"));
    }

    #[test]
    fn bit_depth_over_24_is_error() {
        let r = evaluate(&audio("wav", "pcm_s32le", 44_100, 32));
        assert!(!r.compatible);
        assert!(has(&r, "BIT_DEPTH"));
    }

    #[test]
    fn flac_and_alac_are_warning_but_compatible() {
        let flac = evaluate(&audio("flac", "flac", 44_100, 16));
        assert!(flac.compatible);
        assert!(has(&flac, "NEWER_PLAYERS_ONLY"));

        let alac = evaluate(&audio("mov,mp4,m4a", "alac", 44_100, 16));
        assert!(alac.compatible);
        assert!(has(&alac, "NEWER_PLAYERS_ONLY"));
    }

    #[test]
    fn unknown_codec_is_error() {
        for codec in ["opus", "vorbis", "wmav2"] {
            let r = evaluate(&audio("ogg", codec, 48_000, 0));
            assert!(!r.compatible, "{codec} should be incompatible");
            assert!(has(&r, "UNSUPPORTED_CODEC"));
        }
    }
}
