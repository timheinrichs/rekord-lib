# CDJ hardware test matrix

rekord-lib's whole promise is that a library it has prepared plays on Pioneer
CDJ/XDJ hardware without error codes. Today that promise rests on the
compatibility rules in `src-tauri/src/audio/compat.rs` and on the conversion
settings they drive — not on recorded evidence. This file is where the evidence
goes.

Only outcomes observed on real hardware belong here. Unit tests and the compat
report are useful gates, but neither can tell you that a CDJ-2000NXS accepts a
24-bit AIFF written by our conversion pipeline.

> **Status: no rows yet.** Nothing in this file has been validated on a player.
> Every claim about CDJ compatibility in the README and in the app is currently
> derived from Pioneer's documented format limits, not measured. Adding the
> first rows is tracked as **F4** in
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
| _no rows yet_ | | | | | | | | | |

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
