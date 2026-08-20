#!/usr/bin/env python3
"""Generates a synthetic audio library for development.

Development used to run against the maintainer's real collection, which is a bad
idea for a program that writes tempo tags, rewrites metadata and moves files to
the trash. This builds a library out of nothing instead: every file is a few
seconds of `ffmpeg`-generated tone, shaped to exercise one thing the app has to
get right, and losing all of it costs a re-run of this script.

It is deliberately **not** a replacement for the benchmark set. Measuring tempo
accuracy needs real music with real reference values (see `DSP_BENCHMARK.md`);
this is for driving the app.

Usage:
    scripts/dev-library.py [target-dir] [--force]

Default target: .dev/library (gitignored). Existing files are left alone unless
`--force` is given, so a scan's tag writes are not undone on every call.
"""

import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FFMPEG = os.path.join(ROOT, "src-tauri", "binaries", "ffmpeg-aarch64-apple-darwin")
DEFAULT_TARGET = os.path.join(ROOT, ".dev", "library")
COVER_DIR = os.path.join(ROOT, ".dev", "covers")

# Short on purpose. Tempo detection needs a few seconds of pulse, not minutes,
# and 30 s of stereo AIFF is 5 MB where 150 s would be 26 MB.
SECS = 30


def clicks(bpm: float) -> str:
    """A click track: a decaying tone on every beat. `aevalsrc` rather than a
    sample, so the tempo is exact by construction and the expected result is
    known without measuring anything."""
    return (
        f"aevalsrc='0.6*sin(2*PI*220*t)*exp(-9*mod(t,60/{bpm}))'"
        f":d={SECS}:s=44100"
    )


def tone(freq: int, secs: int = SECS) -> str:
    return f"sine=frequency={freq}:duration={secs}:sample_rate=44100"


def noise() -> str:
    # Deterministic: the same seed every run, so a failure is reproducible.
    return f"anoisesrc=duration={SECS}:sample_rate=44100:seed=1"


def silence() -> str:
    return f"anullsrc=r=44100:cl=stereo:d={SECS}"


# Each entry: relative path, ffmpeg lavfi source, extra output args, tags, a
# cover colour (or None), and what the file is *for* — that last part is why the
# list is worth keeping.
#
# Not every file gets a cover on purpose. "No artwork" is a case the app has to
# render too, and a library where everything has one would never show it.
FILES = [
    # --- tempo detection --------------------------------------------------
    ("Clicks/click-090.aiff", clicks(90), [], {"title": "Click 90"},
     "0x22B27A", "detection should land on 90"),
    ("Clicks/click-128.aiff", clicks(128), [], {"title": "Click 128"},
     "0x6A5FD6", "the common case"),
    ("Clicks/click-174.aiff", clicks(174), [], {"title": "Click 174"},
     "0xF5A623", "above a 70-140 range: narrowing must fold it to 87"),
    ("Clicks/click-127p6.aiff", clicks(127.6), [], {"title": "Click 127.6"},
     "0xE5484D", "fractional tempo — must not come back rounded"),

    # --- nothing to detect ------------------------------------------------
    ("Edge cases/silence.aiff", silence(), [], {"title": "Silence"},
     None, "must get no tempo at all rather than a guess"),
    ("Edge cases/noise.aiff", noise(), [], {"title": "Noise"},
     None, "no periodic pulse: also no tempo"),
    ("Edge cases/too-short.aiff", tone(440, 3), [], {"title": "Too short"},
     None, "3 s — shorter than the detector's minimum"),

    # --- compatibility ----------------------------------------------------
    ("Formats/96khz-24bit.aiff", tone(440),
     ["-ar", "96000", "-c:a", "pcm_s24be"], {"title": "96 kHz 24 bit"},
     None, "needs resampling and a bit-depth change for older players"),
    ("Formats/48khz-16bit.aiff", tone(440), ["-ar", "48000"],
     {"title": "48 kHz 16 bit"}, None, "a sample rate CDJs accept"),
    ("Formats/lossy.mp3", tone(440), ["-c:a", "libmp3lame", "-b:a", "320k"],
     {"title": "Lossy"}, "0x4A4A55", "lossy source: conversion cannot recover it"),
    ("Formats/newer-players.flac", tone(440), ["-c:a", "flac"],
     {"title": "FLAC"}, "0x4A4A55", "plays on CDJ-3000/NXS2 only"),
    ("Formats/plain.wav", tone(440), ["-c:a", "pcm_s16le"],
     {"title": "WAV"}, None, "the other lossless container"),
    ("Formats/aac.m4a", tone(440), ["-c:a", "aac", "-b:a", "256k"],
     {"title": "AAC"}, "0x4A4A55", "MP4 tag mapping differs from ID3"),

    # --- metadata ---------------------------------------------------------
    ("Edge cases/no-tags.aiff", tone(330), [], None,
     None, "no tags at all, and no cover: reads as metadata-incomplete"),

    # --- an album, for grouping ------------------------------------------
    # One cover across the three, the way a real release has: the album header
    # can then show artwork that genuinely represents the group.
    ("Nocturne EP/01 Opening.aiff", clicks(120), [],
     {"title": "Opening", "artist": "Testverse", "album": "Nocturne EP",
      "album_artist": "Testverse", "track": "1", "date": "2026",
      "genre": "Deep House"},
     "0x3B82F6", "album grouping and a complete tag set"),
    ("Nocturne EP/02 Middle.aiff", clicks(120), [],
     {"title": "Middle", "artist": "Testverse", "album": "Nocturne EP",
      "album_artist": "Testverse", "track": "2", "date": "2026",
      "genre": "Deep House"},
     "0x3B82F6", "same album"),
    ("Nocturne EP/03 Closing.aiff", clicks(122), [],
     {"title": "Closing", "artist": "Testverse", "album": "Nocturne EP",
      "album_artist": "Testverse", "track": "3", "date": "2026",
      "genre": "Deep House"},
     "0x3B82F6", "one BPM apart: the group header rounds them"),

    # --- duplicates -------------------------------------------------------
    ("Duplicates/original.aiff", clicks(140), [], {"title": "Twin"},
     "0x8177E0", "duplicate detection: identical audio under two names"),
    ("Duplicates/nested/copy.aiff", clicks(140), [], {"title": "Twin"},
     "0x8177E0", "the copy, in another folder"),
    ("Duplicates/twin-lossy.mp3", clicks(140),
     ["-c:a", "libmp3lame", "-b:a", "320k"], {"title": "Twin"},
     "0x8177E0", "same audio, lossy: the keep-the-best-quality suggestion"),

    # --- filenames --------------------------------------------------------
    ("Edge cases/Oaxaqueño señor.aiff", tone(523), [], {"title": "Oaxaqueño"},
     "0xB7B7C0", "non-ASCII filename, the case NFC/NFD normalisation exists for"),
    ("Edge cases/brackets [remix] & co.aiff", tone(587), [],
     {"title": "Brackets"}, None, "characters the filename sanitiser deals with"),
]


def cover_png(colour: str, target: str) -> str:
    """Draws a flat cover: a coloured field with a dark inner square, so two
    covers are told apart at thumbnail size by hue alone."""
    if not os.path.exists(target):
        subprocess.run(
            [
                FFMPEG, "-v", "error", "-y", "-f", "lavfi",
                "-i",
                f"color=c={colour}:s=500x500,"
                f"drawbox=x=100:y=100:w=300:h=300:color=0x100F14:t=fill",
                "-frames:v", "1", target,
            ],
            check=True,
        )
    return target


def build(path: str, source: str, extra: list, tags, cover: str, force: bool) -> bool:
    if os.path.exists(path) and not force:
        return False
    os.makedirs(os.path.dirname(path), exist_ok=True)
    args = [FFMPEG, "-v", "error", "-y", "-f", "lavfi", "-i", source]
    if cover:
        art = cover_png(cover, os.path.join(COVER_DIR, f"{cover}.png"))
        args += ["-i", art, "-map", "0:a", "-map", "1:v"]
        # AIFF has no attached-picture stream of its own; ffmpeg puts the art in
        # an `ID3 ` chunk instead, which is what lofty reads. Verified against
        # the app's own reader rather than assumed.
        args += ["-c:v", "mjpeg", "-disposition:v", "attached_pic", "-write_id3v2", "1"]
    args += ["-ac", "2"]
    args += extra or []
    for key, value in (tags or {}).items():
        args += ["-metadata", f"{key}={value}"]
    # Written beside the target and moved into place, so the file appears
    # complete or not at all. A dev app watching this folder would otherwise
    # probe a half-written file and log it as unreadable — which is what
    # `--force` did while an app from the previous run was still watching.
    tmp = f"{path}.partial{os.path.splitext(path)[1]}"
    args.append(tmp)
    try:
        subprocess.run(args, check=True)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return True


def main() -> int:
    argv = [a for a in sys.argv[1:] if a != "--force"]
    force = "--force" in sys.argv
    target = argv[0] if argv else DEFAULT_TARGET

    if not os.path.isfile(FFMPEG):
        print(f"no bundled ffmpeg at {FFMPEG}", file=sys.stderr)
        return 1
    # Rewritten in place rather than deleted first: removing the folder makes
    # every file vanish and reappear, which a watching app reports as the whole
    # library being deleted and then re-added.
    if force and os.path.isdir(target):
        shutil.rmtree(COVER_DIR, ignore_errors=True)

    os.makedirs(COVER_DIR, exist_ok=True)
    written = skipped = 0
    for rel, source, extra, tags, cover, _why in FILES:
        if build(os.path.join(target, rel), source, extra, tags, cover, force):
            written += 1
        else:
            skipped += 1

    size = sum(
        os.path.getsize(os.path.join(root, f))
        for root, _, files in os.walk(target)
        for f in files
    )
    print(f"{target}\n  {written} written, {skipped} already there, {size / 1e6:.0f} MB")
    print("  `npm run tauri dev` uses it automatically")
    return 0


if __name__ == "__main__":
    sys.exit(main())
