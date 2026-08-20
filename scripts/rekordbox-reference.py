#!/usr/bin/env python3
"""Turns a Rekordbox XML export into the reference set for `dsp_bench`.

Rekordbox is the ground truth we measure our own tempo detection against: it
analyses every track itself (grid included), which is why its `AverageBpm` is
worth comparing to. The export itself is **not** committed — it lists a whole
personal collection with absolute paths — so this script reduces it to what the
benchmark actually needs.

Filenames are stored as a **hash**, for two reasons: the committed file then
says nothing about which music the collection holds, and the benchmark does not
need the name — it walks the library folder and hashes what it finds. Names are
normalised to NFC first, because the export writes NFC while some files sit on
disk in NFD (26 of 2219 in the first export), and hashing raw bytes would orphan
exactly those rows.

`drift` is what the grid does *within* one track (widest minus narrowest
`<TEMPO>` tempo). A track whose grid wanders by 20 BPM has no single true tempo,
so a one-number detector cannot be scored against it the same way as a steady
one — the benchmark buckets by this column instead of pretending the reference
is equally solid everywhere.

`key` is Rekordbox' `Tonality`, verbatim ("Am", "F#m", "C"). It is deliberately
not converted to Camelot here: the benchmark parses both notations into a pitch
class plus a mode and compares those, so the reference keeps the spelling it was
exported with rather than one this script invented.

A caveat worth knowing when reading benchmark results: Rekordbox' answer
depends on its analysis settings, not just on the audio. Re-analysing the same
2200 tracks after switching from *dynamic* to *automatic, high-precision grid*
moved 1205 tempo values, 90 of them by an exact octave. So the reference is the
best ground truth available, not an oracle — and a regenerated CSV is only
comparable to an older benchmark run if the settings matched. The range those
settings used also lives in the harness (`REFERENCE_MIN_BPM`/`REFERENCE_MAX_BPM`)
and has to be updated along with the export.

Usage:
    scripts/rekordbox-reference.py <rekordbox.xml> [out.csv]

Default output: src-tauri/tests/data/bpm_reference.csv
"""

import collections
import csv
import hashlib
import os
import sys
import unicodedata
import urllib.parse
import xml.etree.ElementTree as ET

DEFAULT_OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "src-tauri", "tests", "data", "bpm_reference.csv",
)

# Prefix length of the hex digest. 16 hex chars = 64 bits, far beyond what a few
# thousand filenames need, and it keeps the file readable.
HASH_LEN = 16


def name_hash(filename: str) -> str:
    """Stable key for a filename: NFC-normalised, hashed, truncated.

    Must stay byte-for-byte in step with the Rust side in
    `src-tauri/tests/dsp_bench.rs` — same normalisation, same digest, same
    truncation, or nothing matches.
    """
    normalised = unicodedata.normalize("NFC", filename)
    digest = hashlib.sha256(normalised.encode("utf-8")).hexdigest()
    return digest[:HASH_LEN]


def location_to_filename(location: str) -> str:
    """The bare filename out of a Rekordbox `Location` URL."""
    path = urllib.parse.unquote(location.replace("file://localhost", ""))
    return os.path.basename(path)


def rows_from(xml_path: str):
    """Reference rows, plus a report of what was dropped and why."""
    root = ET.parse(xml_path).getroot()
    rows = {}
    dropped = collections.Counter()
    collisions = set()

    for track in root.findall("./COLLECTION/TRACK"):
        bpm = float(track.get("AverageBpm") or 0)
        if bpm <= 0:
            dropped["no BPM (never analysed)"] += 1
            continue

        tempos = [float(t.get("Bpm")) for t in track.findall("TEMPO")]
        if not tempos:
            dropped["no grid (BPM from the tag, not from analysis)"] += 1
            continue

        filename = location_to_filename(track.get("Location", ""))
        if not filename:
            dropped["no location"] += 1
            continue

        key = name_hash(filename)
        row = {
            "name_sha256": key,
            "bpm": f"{bpm:.2f}",
            "drift": f"{max(tempos) - min(tempos):.2f}",
            "secs": track.get("TotalTime") or "0",
            # Empty where the collection was never analysed for key. Kept as a
            # row anyway: the tempo reference is useful on its own.
            "key": (track.get("Tonality") or "").strip(),
        }

        # Two files with the same name in different folders hash alike. Keeping
        # both would make the match ambiguous, so they go — unless they agree,
        # in which case either one answers the question.
        if key in rows:
            if rows[key]["bpm"] != row["bpm"]:
                collisions.add(key)
            dropped["duplicate filename"] += 1
            continue
        rows[key] = row

    for key in collisions:
        rows.pop(key, None)
        dropped["duplicate filename, disagreeing BPM"] += 1

    return sorted(rows.values(), key=lambda r: r["name_sha256"]), dropped


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    xml_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT

    rows, dropped = rows_from(xml_path)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", newline="") as fh:
        fh.write(
            "# Rekordbox reference values for src-tauri/tests/dsp_bench.rs.\n"
            "# Generated by scripts/rekordbox-reference.py from a Rekordbox XML\n"
            "# export; regenerate it rather than editing it by hand.\n"
            "#\n"
            "# name_sha256: sha256 of the NFC-normalised filename, first 16 hex\n"
            "#              chars. The audio and the real names stay local.\n"
            "# bpm:         Rekordbox AverageBpm — the value we measure against.\n"
            "# drift:       widest minus narrowest tempo of the track's own grid.\n"
            "#              Large values mean the reference itself is soft.\n"
            "# secs:        track length, used to confirm a hash matched the\n"
            "#              file it was meant to.\n"
            "# key:         Rekordbox Tonality, verbatim. Empty = not analysed.\n"
        )
        writer = csv.DictWriter(
            fh, fieldnames=["name_sha256", "bpm", "drift", "secs", "key"]
        )
        writer.writeheader()
        writer.writerows(rows)

    steady = sum(1 for r in rows if float(r["drift"]) < 0.5)
    keyed = sum(1 for r in rows if r["key"])
    print(f"wrote {len(rows)} reference rows to {out_path}")
    print(f"  steady grid (drift < 0.5 BPM): {steady}")
    print(f"  with a key: {keyed}")
    for reason, count in dropped.most_common():
        print(f"  dropped, {reason}: {count}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
