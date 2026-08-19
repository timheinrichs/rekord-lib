# CDJ hardware test matrix

rekord-lib's whole promise is that a library it has prepared plays on Pioneer
CDJ/XDJ hardware without error codes. Today that promise rests on the
compatibility rules in `src-tauri/src/audio/compat.rs` and on the conversion
settings they drive — not on recorded evidence. This file is where the evidence
goes.

Only outcomes observed on real hardware belong here. Unit tests and the compat
report are useful gates, but neither can tell you that a CDJ-2000NXS accepts a
24-bit AIFF written by our conversion pipeline.

> **Status: partially validated.** AIFF output has played on three players
> without error codes, through a Rekordbox export — see the matrix below. Those
> rows come from field use rather than a structured run, so firmware versions
> and exact dates are missing; read them as strong evidence, not as a completed
> validation. Everything not in the matrix is still derived from Pioneer's
> documented format limits rather than measured. Tracked as **F4** in
> [FUTURE_CONSIDERATIONS.md](FUTURE_CONSIDERATIONS.md).

## Status values

- `pass` — the scenario works end to end on the tested hardware.
- `warn` — usable, but with caveats worth knowing about.
- `fail` — does not work as required.

A `warn` or `fail` row is only useful with a detail block; see
[Recording a warn or fail](#recording-a-warn-or-fail).

## What a row has to cover

rekord-lib prepares files; it does not build the USB drive. A row therefore has
to state the **whole chain** it validated, because a failure could come from any
link in it:

1. the source file (format, sample rate, bit depth, where it came from);
2. what rekord-lib did to it (target format, bit depth, whether tags and cover
   were written);
3. how it reached the drive (Rekordbox version and export, or a plain file
   copy);
4. the player and firmware it was then played on.

A row counts as validated only once all of these were observed:

- the player recognises the drive and mounts the database without a
  communication error;
- the track appears in browse with the title, artist and album rekord-lib wrote;
- the track loads;
- playback starts and runs to the end without dropping out;
- where a cover was embedded, the player shows it.

## Scenarios

The scenario names below are stable identifiers — use them verbatim in the
`Scenario` column so rows for the same case can be compared across app versions.

| Scenario | What it validates |
| --- | --- |
| `aiff-16-44` | The default target: AIFF, uncompressed PCM, 16-bit, 44.1 kHz. |
| `aiff-24-44` | The same at 24-bit, which older players accept but not from every writer. |
| `wav-16-44` | WAV as the target format instead of AIFF. |
| `flac-44` | FLAC, which the app flags as CDJ-3000/NXS2-only — the flag itself is the claim under test. |
| `alac-44` | ALAC, flagged the same way. |
| `mp3-320` | A lossy target, for the players that are fussy about MP3 headers. |
| `downsample-96-to-44` | A 96 kHz source converted down. This is the **E-8305** case the app exists to prevent. |
| `aiff-c-to-pcm` | An AIFF-C source rewritten as uncompressed PCM. |
| `embedded-cover` | Artwork embedded by the conversion shows on the player (≤ 800 px, < 100 KB, JPEG). |
| `tag-fields` | Title, artist, album, album artist, genre and label appear in browse as written. |
| `bpm-tag` | A BPM detected by the app and written to the tag is the one the player shows. |
| `long-filename-unicode` | Non-ASCII titles and filenames browse and load. Worth its own row: this is exactly the class of bug that only hardware finds. |

## Matrix

| Player | Firmware | App version | Scenario | Source → target | Path to drive | Result | Validated | Tester | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| CDJ-2000nexus | not recorded | ≤ 0.4.6 | `aiff-16-44` | → AIFF 16-bit / 44.1 kHz | Rekordbox export | pass | before 2026-08-08 | maintainer | Field use, not a structured run: firmware and exact date not recorded, and the tracks were not chosen to probe the format. No error code, no dropout. |
| CDJ-2000nexus | not recorded | ≤ 0.4.6 | `aiff-24-44` | → AIFF 24-bit / 44.1 kHz | Rekordbox export | pass | before 2026-08-08 | maintainer | Same session and caveats as the 16-bit row above. |
| CDJ-2000nexus | not recorded | ≤ 0.4.6 | `embedded-cover` | → AIFF 16/24-bit | Rekordbox export | pass | before 2026-08-08 | maintainer | Covers embedded by the conversion (JPEG, ≤ 800 px, < 100 KB) displayed on the player. |
| CDJ-2000nexus | not recorded | ≤ 0.4.6 | `tag-fields` | → AIFF 16/24-bit | Rekordbox export | pass | before 2026-08-08 | maintainer | Title, artist and album read as written. Genre, album artist and label were not checked separately. |
| CDJ-3000 | not recorded | ≤ 0.4.6 | `aiff-16-44` | → AIFF 16-bit / 44.1 kHz | Rekordbox export | pass | before 2026-08-08 | maintainer | Field use, not a structured run: firmware and exact date not recorded, and the tracks were not chosen to probe the format. No error code, no dropout. |
| CDJ-3000 | not recorded | ≤ 0.4.6 | `aiff-24-44` | → AIFF 24-bit / 44.1 kHz | Rekordbox export | pass | before 2026-08-08 | maintainer | Same session and caveats as the 16-bit row above. |
| CDJ-3000 | not recorded | ≤ 0.4.6 | `embedded-cover` | → AIFF 16/24-bit | Rekordbox export | pass | before 2026-08-08 | maintainer | Covers embedded by the conversion (JPEG, ≤ 800 px, < 100 KB) displayed on the player. |
| CDJ-3000 | not recorded | ≤ 0.4.6 | `tag-fields` | → AIFF 16/24-bit | Rekordbox export | pass | before 2026-08-08 | maintainer | Title, artist and album read as written. Genre, album artist and label were not checked separately. |
| XDJ-700 | not recorded | ≤ 0.4.6 | `aiff-16-44` | → AIFF 16-bit / 44.1 kHz | Rekordbox export | pass | before 2026-08-08 | maintainer | Field use, not a structured run: firmware and exact date not recorded, and the tracks were not chosen to probe the format. No error code, no dropout. |
| XDJ-700 | not recorded | ≤ 0.4.6 | `aiff-24-44` | → AIFF 24-bit / 44.1 kHz | Rekordbox export | pass | before 2026-08-08 | maintainer | Same session and caveats as the 16-bit row above. |
| XDJ-700 | not recorded | ≤ 0.4.6 | `embedded-cover` | → AIFF 16/24-bit | Rekordbox export | pass | before 2026-08-08 | maintainer | Covers embedded by the conversion (JPEG, ≤ 800 px, < 100 KB) displayed on the player. |
| XDJ-700 | not recorded | ≤ 0.4.6 | `tag-fields` | → AIFF 16/24-bit | Rekordbox export | pass | before 2026-08-08 | maintainer | Title, artist and album read as written. Genre, album artist and label were not checked separately. |

**About the app version.** These sessions predate BPM detection, which shipped in
0.4.7 on 2026-08-08 — that is what dates them at 0.4.6 or earlier. The tempo
values seen on the players came from Rekordbox's own analysis, not from a tag
rekord-lib wrote, so they say nothing about `bpm-tag`.

### Not yet validated

Every scenario below is still an inference from the format rules, not an
observation. `downsample-96-to-44` is the most valuable gap: it is the case the
app exists to prevent, and the one where being wrong is most expensive.

| Scenario | Why it still matters |
| --- | --- |
| `downsample-96-to-44` | The **E-8305** case. No row means the central claim is untested on hardware. |
| `aiff-c-to-pcm` | An AIFF-C source rewritten as uncompressed PCM — a rewrite, not just a re-encode. |
| `wav-16-44` | WAV as the target instead of AIFF. |
| `flac-44`, `alac-44` | Our CDJ-3000/NXS2-only flag is the claim under test. A `fail` on a CDJ-2000nexus would confirm it; a `pass` on a CDJ-3000 would confirm the other half. |
| `mp3-320` | Not covered by the AIFF rows at all. |
| `bpm-tag` | The BPM the app detects and writes has never been read off a player. |
| `long-filename-unicode` | Untested, and exactly the class of bug only hardware finds. |

## Recording a warn or fail

Every non-`pass` row needs a detail block in its `Notes` cell, so the row is
actionable months later without the hardware in front of you:

```text
Symptoms:
- exactly what the player did

Reproduction:
1. step-by-step, starting from the source file

Context:
- the library/drive content needed to reproduce it

Artifacts:
- what was captured (ffprobe output, a photo of the display, the file itself)

Open questions:
- what still needs confirming on hardware
```

## Keeping this honest

- Add a row when a scenario is observed, not when it is expected to work.
- A row is tied to one app version. A change to `compat.rs`, to the conversion
  settings, or to the ffmpeg sidecars invalidates nothing automatically — but it
  does mean the affected scenarios deserve re-validation before the claim is
  repeated in a release.
- A `fail` row stays in the file after it is fixed. The `pass` row for the fixed
  version goes underneath it, and the `fail` row's notes say which version fixed
  it. The history is the point.
