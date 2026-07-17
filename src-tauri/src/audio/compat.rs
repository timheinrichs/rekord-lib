use crate::models::{AudioInfo, CompatIssue, CompatReport, Severity};

/// Auf allen CDJ/XDJ unterstützte Samplerates.
const SUPPORTED_SAMPLE_RATES: [u32; 2] = [44_100, 48_000];

/// Auf allen Playern lauffähige, verlustbehaftete Container/Codecs.
fn is_universal_lossy(codec: &str) -> bool {
    matches!(codec, "mp3" | "aac")
}

/// Bewertet, ob eine Datei so wie sie ist auf allen Pioneer CDJ/XDJ läuft.
///
/// Grundlage sind die dokumentierten Hardware-Grenzen: nur unkomprimiertes PCM
/// in AIFF/WAV, Samplerate 44,1/48 kHz, 16/24-bit; MP3/AAC universell;
/// FLAC/ALAC nur auf neueren Playern (CDJ-3000/NXS2).
pub fn evaluate(audio: &AudioInfo) -> CompatReport {
    let mut issues = Vec::new();

    // 1. Samplerate
    if audio.sample_rate == 0 {
        issues.push(CompatIssue {
            code: "SAMPLE_RATE_UNKNOWN".into(),
            message: "Samplerate konnte nicht bestimmt werden.".into(),
            severity: Severity::Warning,
        });
    } else if !SUPPORTED_SAMPLE_RATES.contains(&audio.sample_rate) {
        issues.push(CompatIssue {
            code: "SAMPLE_RATE".into(),
            message: format!(
                "{} Hz wird nicht unterstützt (E-8305). Nötig: 44.100 oder 48.000 Hz.",
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

    // 2. AIFF/WAV müssen unkomprimiertes PCM sein (kein AIFF-C).
    if (is_aiff || is_wav) && !is_pcm {
        issues.push(CompatIssue {
            code: "COMPRESSED_PCM_CONTAINER".into(),
            message: format!(
                "{} mit Codec „{}“ (z. B. AIFF-C) wird nicht abgespielt (E-8305). Nur unkomprimiertes PCM.",
                container, codec
            ),
            severity: Severity::Error,
        });
    }

    // 3. Bit-Tiefe: >24-bit bzw. 32-bit-Float wird nicht unterstützt.
    if is_pcm && audio.bits_per_sample > 24 {
        issues.push(CompatIssue {
            code: "BIT_DEPTH".into(),
            message: format!(
                "{}-bit PCM wird nicht unterstützt. Nötig: 16- oder 24-bit.",
                audio.bits_per_sample
            ),
            severity: Severity::Error,
        });
    }

    // 4. FLAC/ALAC laufen nur auf neueren Playern.
    if codec == "flac" || codec == "alac" {
        issues.push(CompatIssue {
            code: "NEWER_PLAYERS_ONLY".into(),
            message: format!(
                "{} läuft nur auf neueren Playern (CDJ-3000/NXS2), nicht auf allen CDJ/XDJ.",
                codec.to_uppercase()
            ),
            severity: Severity::Warning,
        });
    }

    // 5. Grundsätzlich nicht unterstützte Formate (weder universelles Lossy
    //    noch PCM noch FLAC/ALAC), z. B. ogg/opus/wma.
    let is_known_supported =
        is_pcm || is_universal_lossy(&codec) || codec == "flac" || codec == "alac";
    if !is_known_supported {
        issues.push(CompatIssue {
            code: "UNSUPPORTED_CODEC".into(),
            message: format!("Codec „{}“ wird von CDJ/XDJ nicht unterstützt.", codec),
            severity: Severity::Error,
        });
    }

    let compatible = !issues.iter().any(|i| i.severity == Severity::Error);

    CompatReport { compatible, issues }
}
