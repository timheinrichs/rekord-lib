//! Writing a `rekordbox.xml` collection.
//!
//! The point of the whole app arrives here: the files are correct, the tempo
//! and the key are known, the playlists are made — and until now the handoff
//! was "go import them in Rekordbox", which threw away everything except the
//! tags. This writes the format Rekordbox reads in one step.
//!
//! **The format is not guessed.** `scripts/rekordbox-reference.py` has been
//! reading real exports from this collection since the tempo benchmark existed,
//! so the field names, the `Location` encoding and the `TEMPO` shape below come
//! from files Rekordbox itself wrote. The round trip is a test: what this writes
//! goes back through that reader and has to come out as the rows it went in as.
//!
//! **What is deliberately not written.** Cue points — the app has no concept of
//! one, and inventing empty ones would put marks in somebody's player that
//! nobody set. And nothing at all for a track with no tempo:
//! `AverageBpm="0.00"` is what Rekordbox writes for "not analysed", and that is
//! the honest value.
//!
//! **Artwork is not in this format.** There is no attribute for it; Rekordbox
//! reads the cover out of the file itself, once the track is imported into the
//! collection rather than only browsed in the xml view. Nothing to write here,
//! and nothing missing.

use crate::models::{Playlist, TrackAnalysis};

/// One playlist and the paths in it, in order.
pub type PlaylistExport = (Playlist, Vec<String>);

/// The whole document, as a string.
///
/// A string rather than a writer: an XML collection of a few thousand tracks is
/// a couple of megabytes, the caller writes it in one go, and being able to
/// assert on the result in a test is worth more here than streaming would be.
/// `sizes` is the file size per path. Not on the track row — the scan keeps the
/// size as part of the cache identity, not as something the UI shows — so the
/// caller stats the files and hands them over. A path that is missing simply
/// gets no `Size`, which is what an unreadable file deserves.
pub fn collection_xml(
    tracks: &[TrackAnalysis],
    playlists: &[PlaylistExport],
    sizes: &std::collections::HashMap<String, u64>,
) -> String {
    // Rekordbox keys playlist entries by TrackID, so every track needs one that
    // is stable within the document. The index is exactly that, and nothing
    // outside the file refers to it.
    let id_of = |path: &str| {
        tracks
            .iter()
            .position(|t| t.path == path)
            .map(|i| i as i64 + 1)
    };

    let mut out = String::with_capacity(tracks.len() * 512);
    out.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    out.push_str("<DJ_PLAYLISTS Version=\"1.0.0\">\n");
    out.push_str(&format!(
        "  <PRODUCT Name=\"rekord-lib\" Version=\"{}\" Company=\"rekord-lib\"/>\n",
        env!("CARGO_PKG_VERSION")
    ));

    out.push_str(&format!(
        "  <COLLECTION Entries=\"{}\">\n",
        tracks.len()
    ));
    for (i, track) in tracks.iter().enumerate() {
        out.push_str(&track_xml(track, i as i64 + 1, sizes.get(&track.path).copied()));
    }
    out.push_str("  </COLLECTION>\n");

    out.push_str(&format!(
        "  <PLAYLISTS>\n    <NODE Type=\"0\" Name=\"ROOT\" Count=\"{}\">\n",
        playlists.len()
    ));
    for (playlist, paths) in playlists {
        // Only the tracks that are in the collection: an entry pointing at a
        // TrackID that is not there is a playlist Rekordbox silently shortens.
        let ids: Vec<i64> = paths.iter().filter_map(|p| id_of(p)).collect();
        out.push_str(&format!(
            "      <NODE Name=\"{}\" Type=\"1\" KeyType=\"0\" Entries=\"{}\">\n",
            escape(&playlist.name),
            ids.len()
        ));
        for id in ids {
            out.push_str(&format!("        <TRACK Key=\"{id}\"/>\n"));
        }
        out.push_str("      </NODE>\n");
    }
    out.push_str("    </NODE>\n  </PLAYLISTS>\n</DJ_PLAYLISTS>\n");
    out
}

fn track_xml(t: &TrackAnalysis, id: i64, size: Option<u64>) -> String {
    let md = &t.metadata;
    let attr = |name: &str, value: &str| {
        if value.is_empty() {
            String::new()
        } else {
            format!(" {name}=\"{}\"", escape(value))
        }
    };

    let mut line = format!("    <TRACK TrackID=\"{id}\"");
    // `Name` is the one attribute Rekordbox will not do without: a track with
    // no title tag shows as its file name everywhere else in this app, and it
    // should not become a blank row there either.
    line.push_str(&attr(
        "Name",
        md.title.as_deref().unwrap_or(&t.file_name),
    ));
    line.push_str(&attr("Artist", md.artist.as_deref().unwrap_or("")));
    line.push_str(&attr("Album", md.album.as_deref().unwrap_or("")));
    line.push_str(&attr("AlbumArtist", md.album_artist.as_deref().unwrap_or("")));
    line.push_str(&attr("Genre", md.genre.as_deref().unwrap_or("")));
    line.push_str(&attr("Label", md.label.as_deref().unwrap_or("")));
    line.push_str(&attr("Kind", kind_of(&t.audio.container)));
    line.push_str(&format!(
        " TotalTime=\"{}\"",
        t.audio.duration_secs.round().max(0.0) as i64
    ));
    line.push_str(&format!(" SampleRate=\"{}\"", t.audio.sample_rate));
    if let Some(size) = size {
        line.push_str(&format!(" Size=\"{size}\""));
        // The average over the whole file, which is also the only honest number
        // for a VBR mp3 — and what Rekordbox shows for one anyway. Without it
        // its summary panel reads "0 kbps", which looks like a broken file.
        if let Some(kbps) = bitrate_kbps(size, t.audio.duration_secs) {
            line.push_str(&format!(" BitRate=\"{kbps}\""));
        }
    }
    if let Some(n) = md.track_number {
        line.push_str(&format!(" TrackNumber=\"{n}\""));
    }
    if let Some(year) = md.year.as_deref().and_then(|y| y.trim().parse::<i32>().ok()) {
        line.push_str(&format!(" Year=\"{year}\""));
    }
    // Two decimals, the way Rekordbox writes it and the way our own tag writer
    // spells a tempo — one value, one spelling, wherever it is read.
    line.push_str(&format!(" AverageBpm=\"{:.2}\"", md.bpm.unwrap_or(0.0)));
    line.push_str(&attr("Tonality", t.key.as_deref().unwrap_or("")));
    if let Some(added) = t.download_date.map(date_of_ms) {
        line.push_str(&format!(" DateAdded=\"{added}\""));
    }
    line.push_str(&format!(" Location=\"{}\"", location_url(&t.path)));

    // The grid: one marker, because our detector produces one tempo per track,
    // so a grid is a period and a phase (B3). `Metro` and `Battito` say "4/4,
    // and this marker is beat 1" — the bar position we do not detect, which is
    // why every marker claims the same one rather than pretending to know.
    match (md.bpm, t.beat_offset_secs) {
        (Some(bpm), Some(offset)) if bpm > 0.0 => {
            line.push_str(">\n");
            line.push_str(&format!(
                "      <TEMPO Inizio=\"{offset:.3}\" Bpm=\"{bpm:.2}\" Metro=\"4/4\" Battito=\"1\"/>\n",
            ));
            line.push_str("    </TRACK>\n");
        }
        _ => line.push_str("/>\n"),
    }
    line
}

/// `file://localhost/…`, percent-encoded — the form every `Location` in a real
/// export has.
///
/// Everything outside the unreserved set is escaped, `/` excepted, and escaping
/// happens per UTF-8 byte, which is what makes a non-ASCII filename survive the
/// trip. The reader on the other side is `urllib.parse.unquote`, so the test
/// that matters is the round trip rather than the exact set of characters.
pub fn location_url(path: &str) -> String {
    let mut out = String::from("file://localhost");
    for byte in path.as_bytes() {
        let c = *byte as char;
        if byte.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~' | '/') {
            out.push(c);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Average bit rate in kbps, or `None` for a file with no length to divide by.
fn bitrate_kbps(size: u64, duration_secs: f64) -> Option<u64> {
    if duration_secs <= 0.0 {
        return None;
    }
    Some((size as f64 * 8.0 / duration_secs / 1000.0).round() as u64)
}

/// What Rekordbox calls this kind of file.
fn kind_of(container: &str) -> &'static str {
    match container.to_ascii_lowercase().as_str() {
        "aiff" | "aif" => "AIFF File",
        "wav" | "wave" => "WAV File",
        "mp3" => "MP3 File",
        "flac" => "FLAC File",
        "m4a" | "mp4" | "aac" => "M4A File",
        _ => "Unknown",
    }
}

/// `YYYY-MM-DD` from epoch milliseconds, UTC.
///
/// Written out rather than pulled in: a date crate for one attribute would be a
/// dependency in a bundle that ships to other people's machines, and the
/// civil-from-days arithmetic is a known, testable dozen lines.
fn date_of_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // Howard Hinnant's civil_from_days, with the era starting on 0000-03-01.
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!("{year:04}-{m:02}-{d:02}")
}

/// XML attribute escaping. Everything here ends up inside double quotes, so
/// those and the markup characters are the whole list.
fn escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // A control character in a tag is not representable in XML 1.0 at
            // all, and a file that will not parse is worse than a lost
            // character.
            c if (c as u32) < 0x20 && c != '\t' && c != '\n' && c != '\r' => {}
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AudioInfo, CompatReport, TrackAnalysis, TrackMetadata};

    fn track(path: &str, title: &str) -> TrackAnalysis {
        TrackAnalysis {
            id: path.into(),
            path: path.into(),
            file_name: path.rsplit('/').next().unwrap_or(path).into(),
            audio: AudioInfo {
                container: "aiff".into(),
                codec: "pcm_s16be".into(),
                sample_rate: 44_100,
                bits_per_sample: 16,
                channels: 2,
                duration_secs: 210.4,
                lossless: true,
            },
            metadata: TrackMetadata {
                title: Some(title.into()),
                artist: Some("Testverse".into()),
                album: Some("Nocturne EP".into()),
                bpm: Some(128.0),
                ..Default::default()
            },
            compat: CompatReport {
                compatible: true,
                issues: vec![],
            },
            metadata_incomplete: false,
            download_date: Some(1_767_225_600_000), // 2026-01-01
            bpm_confidence: Some(0.8),
            key: Some("Am".into()),
            key_camelot: Some("8A".into()),
            key_confidence: Some(0.5),
            bpm_absent: false,
            beat_offset_secs: Some(30.25),
            beat_confidence: Some(0.7),
        }
    }

    /// No sizes, for the cases that are not about the size.
    fn nothing() -> std::collections::HashMap<String, u64> {
        std::collections::HashMap::new()
    }

    fn list(id: i64, name: &str) -> Playlist {
        Playlist {
            id,
            name: name.into(),
            created_ms: 0,
            updated_ms: 0,
            track_count: 0,
        }
    }

    #[test]
    fn a_track_carries_what_the_app_knows_about_it() {
        let xml = collection_xml(&[track("/lib/a.aiff", "Opening")], &[], &nothing());
        assert!(xml.contains("<DJ_PLAYLISTS Version=\"1.0.0\">"));
        assert!(xml.contains("TrackID=\"1\""));
        assert!(xml.contains("Name=\"Opening\""));
        assert!(xml.contains("Artist=\"Testverse\""));
        assert!(xml.contains("AverageBpm=\"128.00\""), "{xml}");
        assert!(xml.contains("Tonality=\"Am\""));
        assert!(xml.contains("TotalTime=\"210\""));
        assert!(xml.contains("SampleRate=\"44100\""));
        assert!(xml.contains("Kind=\"AIFF File\""));
        assert!(xml.contains("DateAdded=\"2026-01-01\""), "{xml}");
        // The grid, on the track's own clock.
        assert!(
            xml.contains("<TEMPO Inizio=\"30.250\" Bpm=\"128.00\" Metro=\"4/4\" Battito=\"1\"/>"),
            "{xml}"
        );
    }

    #[test]
    fn a_track_with_no_grid_is_a_single_empty_element() {
        let mut t = track("/lib/a.aiff", "Opening");
        t.beat_offset_secs = None;
        let xml = collection_xml(&[t], &[], &nothing());
        assert!(!xml.contains("<TEMPO"));
        assert!(xml.contains("/>\n"), "{xml}");
    }

    #[test]
    fn a_track_with_no_tempo_says_zero_rather_than_nothing() {
        // What Rekordbox itself writes for "not analysed" — the value its own
        // reader expects, and the one `rekordbox-reference.py` drops on purpose.
        let mut t = track("/lib/a.aiff", "Interlude");
        t.metadata.bpm = None;
        t.beat_offset_secs = None;
        let xml = collection_xml(&[t], &[], &nothing());
        assert!(xml.contains("AverageBpm=\"0.00\""), "{xml}");
    }

    #[test]
    fn an_untitled_track_falls_back_to_its_file_name() {
        // A blank row in Rekordbox would be worse than the name it already
        // shows everywhere in this app.
        let mut t = track("/lib/no-tags.aiff", "");
        t.metadata.title = None;
        let xml = collection_xml(&[t], &[], &nothing());
        assert!(xml.contains("Name=\"no-tags.aiff\""), "{xml}");
    }

    #[test]
    fn playlists_point_at_the_tracks_by_id() {
        let tracks = [track("/lib/a.aiff", "A"), track("/lib/b.aiff", "B")];
        let playlists = vec![(
            list(1, "Warmup"),
            vec!["/lib/b.aiff".to_string(), "/lib/a.aiff".to_string()],
        )];
        let xml = collection_xml(&tracks, &playlists, &nothing());
        assert!(xml.contains("<NODE Name=\"Warmup\" Type=\"1\" KeyType=\"0\" Entries=\"2\">"));
        // In playlist order, which is the whole point of storing an order.
        let first = xml.find("<TRACK Key=\"2\"/>").unwrap();
        let second = xml.find("<TRACK Key=\"1\"/>").unwrap();
        assert!(first < second, "{xml}");
    }

    #[test]
    fn a_playlist_entry_with_no_track_in_the_collection_is_left_out() {
        // Rekordbox silently shortens a playlist that points at a missing id;
        // better to write the right count than to have it corrected for us.
        let tracks = [track("/lib/a.aiff", "A")];
        let playlists = vec![(
            list(1, "Set"),
            vec!["/lib/a.aiff".to_string(), "/lib/gone.aiff".to_string()],
        )];
        let xml = collection_xml(&tracks, &playlists, &nothing());
        assert!(xml.contains("Entries=\"1\""), "{xml}");
    }

    #[test]
    fn names_that_would_break_the_document_are_escaped() {
        let mut t = track("/lib/a.aiff", "Rock & \"Roll\" <mix>");
        t.metadata.artist = Some("A & B".into());
        let playlists = vec![(list(1, "Peak & Close"), vec!["/lib/a.aiff".to_string()])];
        let xml = collection_xml(&[t], &playlists, &nothing());
        assert!(xml.contains("Name=\"Rock &amp; &quot;Roll&quot; &lt;mix&gt;\""), "{xml}");
        assert!(xml.contains("Name=\"Peak &amp; Close\""));
        assert!(!xml.contains("& \""), "a bare ampersand would not parse");
    }

    #[test]
    fn a_location_is_a_percent_encoded_file_url() {
        assert_eq!(
            location_url("/Users/me/Music/Track 01.aiff"),
            "file://localhost/Users/me/Music/Track%2001.aiff"
        );
        // The characters that actually turn up in a music folder.
        assert_eq!(
            location_url("/lib/Oaxaqueño señor.aiff"),
            "file://localhost/lib/Oaxaque%C3%B1o%20se%C3%B1or.aiff"
        );
        assert!(location_url("/lib/a#b&c.aiff").contains("a%23b%26c"));
        // Separators stay separators.
        assert!(location_url("/a/b/c.aiff").contains("/a/b/c.aiff"));
    }

    /// The check that speaks the other side's language.
    ///
    /// `scripts/rekordbox-reference.py` was written against exports Rekordbox
    /// produced, and it is the only reader here that did not come out of the
    /// same head as the writer. If what we write cannot be read by it, the
    /// field names or the encoding are wrong however green the assertions
    /// above are.
    #[test]
    fn what_we_write_is_read_back_by_the_reference_reader() {
        let dir = tempfile::tempdir().unwrap();
        let xml_path = dir.path().join("rekordbox.xml");
        let csv_path = dir.path().join("out.csv");

        let mut a = track("/lib/Oaxaqueño señor.aiff", "Oaxaqueño");
        a.metadata.bpm = Some(127.6);
        a.beat_offset_secs = Some(30.5);
        let b = track("/lib/b.aiff", "Beta");
        std::fs::write(&xml_path, collection_xml(&[a, b], &[], &nothing())).unwrap();

        let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("scripts/rekordbox-reference.py");
        let out = std::process::Command::new("python3")
            .arg(&script)
            .arg(&xml_path)
            .arg(&csv_path)
            .output()
            .expect("python3 is available on a dev machine and in CI");
        assert!(
            out.status.success(),
            "reader failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );

        let csv = std::fs::read_to_string(&csv_path).unwrap();
        // Both tracks survived: a name with non-ASCII in it is the one that
        // would not, if the Location encoding were wrong.
        let rows = csv.lines().filter(|l| !l.starts_with('#') && l.contains(',')).count() - 1;
        assert_eq!(rows, 2, "{csv}");
        // The values it reads back are the ones we put in.
        assert!(csv.contains("127.60"), "{csv}");
        assert!(csv.contains("30.5000"), "{csv}");
        assert!(csv.contains(",Am,"), "{csv}");
    }

    #[test]
    fn a_size_brings_a_bit_rate_with_it() {
        // Without them Rekordbox' summary reads "0 Byte, 0 kbps", which looks
        // like a broken file rather than a field we did not fill in.
        let sizes = std::collections::HashMap::from([("/lib/a.aiff".to_string(), 37_108_800u64)]);
        let xml = collection_xml(&[track("/lib/a.aiff", "Opening")], &[], &sizes);
        assert!(xml.contains("Size=\"37108800\""), "{xml}");
        // 37,108,800 bytes over 210.4 s ≈ 1411 kbps, which is CD PCM.
        assert!(xml.contains("BitRate=\"1411\""), "{xml}");
    }

    #[test]
    fn a_file_that_cannot_be_stated_is_exported_without_one() {
        let xml = collection_xml(&[track("/lib/a.aiff", "Opening")], &[], &nothing());
        assert!(!xml.contains("Size="));
        assert!(!xml.contains("BitRate="));
    }

    #[test]
    fn a_track_with_no_length_has_no_bit_rate_to_state() {
        // Division by zero would otherwise reach the file as `inf`.
        assert_eq!(bitrate_kbps(1000, 0.0), None);
        assert_eq!(bitrate_kbps(1000, -1.0), None);
    }

    #[test]
    fn dates_are_the_civil_date_of_the_stamp() {
        assert_eq!(date_of_ms(0), "1970-01-01");
        assert_eq!(date_of_ms(1_767_225_600_000), "2026-01-01");
        // A leap day, which is the one the arithmetic gets wrong when it is
        // wrong at all.
        assert_eq!(date_of_ms(1_709_164_800_000), "2024-02-29");
    }
}
