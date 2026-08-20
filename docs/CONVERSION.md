# Compatibility and conversion

Item **F1** from [FUTURE_CONSIDERATIONS.md](FUTURE_CONSIDERATIONS.md): which
files a CDJ refuses and why, what the app changes to fix that, and what
"compatible" is actually claiming. The app's whole promise sits in this file's
subject.

## How it works

Two halves that are easy to confuse. **Compatibility is a verdict**, computed
from what ffprobe read; **conversion is the repair**, and it only happens when
the user asks for it.

```
probe            ffprobe → AudioInfo { container, codec, sample_rate,
                 bits_per_sample, channels, duration, lossless }
                 a stream with no sample rate or no channels is not audio
                 → the file is skipped with a reason, never stored as a row

compat           compat::evaluate(&AudioInfo)
                 → CompatReport { compatible, issues }
                 recomputed on every read, never stored

convert          convert_tracks(jobs, options), strictly one job after another
                 │  metadata = the pending edit, else the source file's own tags
                 ├─ ffmpeg sidecar: codec + bit depth per target format,
                 │  resample to 44.1 kHz if the source is not 44.1/48
                 │  in-place? write to stem.rekordtmpN.ext next to the target
                 │  progress from ffmpeg's -progress pipe, clamped to 99 %
                 ├─ lofty: re-apply tags and cover (stage "Metadata", 100 %)
                 ├─ rename the temp over the target if there was one
                 └─ replace_source and a different output path? trash the source
```

Afterwards the frontend re-analyses whatever came out, so the row shows the
converted file rather than the old verdict.

## Deep technical details

### The five rules, in order

`compat::evaluate` produces issues, each with a code and a severity, and
`compatible` is simply "no issue of severity Error".

| Code | When | Severity |
| --- | --- | --- |
| `SAMPLE_RATE_UNKNOWN` | ffprobe reported no sample rate | Warning |
| `SAMPLE_RATE` | anything other than 44.1 or 48 kHz — the message names **E-8305** | Error |
| `COMPRESSED_PCM_CONTAINER` | an AIFF or WAV container whose codec is not `pcm_*` | Error |
| `BIT_DEPTH` | PCM above 24 bit, which includes 32-bit float | Error |
| `NEWER_PLAYERS_ONLY` | codec `flac` or `alac` — CDJ-3000/NXS2 only | Warning |
| `UNSUPPORTED_CODEC` | not PCM, not MP3/AAC, not FLAC/ALAC — ogg, opus, wma | Error |

Three of those are worth stating in words.

**"Compatible" means "no error", not "plays everywhere".** A FLAC file is
reported as compatible *and* carries `NEWER_PLAYERS_ONLY`. That is deliberate —
refusing to call it compatible would be wrong on a CDJ-3000 — but it means the
word alone is not the whole answer, and the UI shows the issues next to it.

**An unknown sample rate is a warning, not an error.** A missing measurement is
not evidence of a problem, and blocking a file because ffprobe was vague would
be the app inventing a fault.

**AIFF-C is detected structurally, not by name.** The rule is "AIFF or WAV
container whose codec does not start with `pcm_`", which catches `sowt` and
everything like it. There is no AIFF-C string anywhere in the code, and there
does not need to be.

The bit-depth rule applies **only** to PCM, so a lossy file reporting 0 bits is
unaffected.

### Files that are not really audio

ffprobe identifies a file by its extension as readily as by its content: four
bytes of text named `.flac` probe *successfully*, as a FLAC stream with 0 Hz and
no channels. That used to land in the library as a track that could never be
played or converted. `is_playable` rejects a stream with no sample rate or no
channels, which turns it into a skip with a reason instead of a poisonous row.

`probe_error` turns what ffprobe actually said into one line. It prefers a
`dyld` line when there is one — a loader failure puts the diagnosis first — and
falls back to the last line otherwise, because ffprobe's own errors put it last.

### What conversion changes

**It resamples down, never up.** `target_sample_rate` keeps 44.1 and 48 kHz and
sends everything else to 44.1 kHz — including 22.05 kHz, which no player likes
either.

Per target format, from `build_args`: AIFF is `pcm_s24be`/`pcm_s16be` plus
`-write_id3v2 1` — that flag is the reason AIFF tags survive at all; WAV is the
little-endian equivalent; FLAC and ALAC use `-sample_fmt s32`/`s32p` for
"24-bit", because there is no s24 sample format; MP3 and AAC are 320 kbit/s, and
the bit-depth control is disabled for them in the settings.

`sanitize` replaces the characters that a CDJ or a FAT filesystem trips over,
and it is off by default: renaming a user's files is not something to do
unrequested.

### The load-bearing line

ffmpeg's muxers carry almost no tags — the AIFF muxer keeps little more than the
title — so everything is re-applied with lofty after the encode. Which means:

```rust
let metadata = match &job.metadata {
    Some(md) => Some(md.clone()),
    None => read_metadata(&job.path).ok(),
};
```

**Without that fallback, converting a file with no pending edit silently drops
artist, album, label and BPM.** It is one line, it looks like defensive
programming, and it is the difference between a conversion and a data loss.

### In-place conversion

Converting AIFF to AIFF writes to `stem.rekordtmpN.ext` beside the target and
renames afterwards, because ffmpeg would otherwise be writing the file it is
reading. `paths_equal` canonicalises both sides to notice the case.

The order matters twice over: the cover is read from the **source**, which is
still intact at that point, and only then is the temp file moved over it.

`replace_source` trashes the original only when the output is a *different* path
— an in-place conversion has no source left to remove. And it goes to the trash,
never `remove_file`: it is the user's own audio, and a conversion they did not
mean has to be recoverable. It is set for library conversions and not for files
dragged in from outside.

### Progress, and the three ways it can fail

Progress is clamped to 99 % while ffmpeg runs; 100 % is emitted on a clean exit,
and a second 100 % event with `stage: "Metadata"` marks the tagging phase. So a
bar that sits at 99 % is waiting for ffmpeg to exit, not stuck.

Failure is reported per job, with three distinct cleanups: an ffmpeg failure
removes the temp file and reports no output; a tagging failure removes the temp
but still reports the output path with "Converted, but metadata failed", because
the audio *is* there; a failed rename removes the temp and reports no output.

Conversion is **strictly sequential** — one job after another, no worker budget,
unlike every analysis pass. ffmpeg saturates what it is given.

### The sidecars underneath all of this

Analysis and conversion both shell out to bundled `ffmpeg`/`ffprobe` binaries.
They must link only against `/usr/lib` and `/System/…`; a Homebrew-linked binary
crashes with `dyld: Library not loaded` on a machine that has no Homebrew, and
then everything here fails at once. `sidecars_are_self_contained` enforces that
in CI, and `audio::sidecar::self_test` runs both binaries once at startup so a
field failure shows up as a banner and a log entry rather than as everything
being mysteriously broken.

One more thing that only real audio taught us: `decode::mono_pcm` needs
`set_raw_out(true)` and manual event consumption. Collecting the child's output
the ordinary way re-appends a newline per chunk, which shifts 16-bit sample
alignment and turns PCM into noise — affecting the fingerprint, the waveform and
the tempo alike.

## Implementation anchors

| Where | What |
| --- | --- |
| `src-tauri/src/audio/compat.rs` · `evaluate` | the five rules and `SUPPORTED_SAMPLE_RATES` |
| `src-tauri/src/audio/probe.rs` · `probe`, `is_playable`, `probe_error` | what a file claims to be, and when that is not believed |
| … · `is_lossless_codec` | which codecs count as lossless |
| `src-tauri/src/audio/convert.rs` · `convert_file` | one file: probe, args, spawn, progress |
| … · `target_sample_rate`, `build_args` | the actual repair, per target format |
| … · `output_path`, `sanitize`, `temp_sibling`, `paths_equal` | where the output goes and how in-place is handled |
| … · `parse_progress` | ffmpeg's `-progress` output, and the clamp to 99 |
| `src-tauri/src/commands.rs` · `convert_tracks` | the orchestration: metadata fallback, tagging, rename, trash, cleanups |
| `src-tauri/src/audio/sidecar.rs` · `self_test`, `failure_message` | proving the binaries can run before anything needs them |
| `src-tauri/src/metadata/write.rs` · `finalize` | re-applying tags after the encode; see [METADATA.md](METADATA.md) |
| `src-tauri/src/models.rs` · `TargetFormat`, `ConvertOptions`, `ConvertJob`, `ConvertResult` | the target formats and their extensions |
| `src/lib/settings.ts` · `DEFAULT_SETTINGS` | AIFF, 16-bit, no filename sanitising |
| `src/components/SettingsView.tsx` | the format and bit-depth controls, and the newer-players warning |
| `src/components/LibraryView.tsx` · `jobFor`, `runConvert`, `convertSelected` | building jobs, and `replace_source` per mode |
| `src/lib/librarySync.ts` · `convertedOutputs`, `mergeConverted` | re-analysing what came out and folding it into the list |
| `src/components/StatusIcons.tsx` | how an issue reaches the user |
| `src-tauri/binaries/`, `scripts/build-static-ffmpeg.sh` | the sidecars themselves |

## Verification links

| Claim | Test |
| --- | --- |
| A clean AIFF is compatible; MP3/AAC are too | `compat.rs` · `clean_aiff_pcm_is_compatible`, `universal_lossy_is_compatible` |
| A wrong sample rate is an error, an unknown one only a warning | `compat.rs` · `unsupported_sample_rate_is_error`, `zero_sample_rate_is_warning_not_error` |
| AIFF-C is an error | `compat.rs` · `compressed_pcm_container_is_error` |
| Above 24-bit PCM is an error | `compat.rs` · `bit_depth_over_24_is_error` |
| FLAC/ALAC warn but stay compatible | `compat.rs` · `flac_and_alac_are_warning_but_compatible` |
| An unknown codec is an error | `compat.rs` · `unknown_codec_is_error` |
| Only unsupported rates are changed | `convert.rs` · `target_sample_rate_keeps_supported_and_falls_back` |
| The output path, extension and optional sanitising | `convert.rs` · `output_path_uses_output_dir_and_extension`, `output_path_defaults_next_to_source`, `output_path_sanitizes_stem_when_requested`, `sanitize_replaces_problem_chars` |
| Codec and bit depth per format, first audio stream only | `convert.rs` · `build_args_selects_codec_and_bit_depth`, `build_args_carries_metadata_and_first_audio_stream` |
| In-place detection and the temp file's shape | `convert.rs` · `paths_equal_detects_same_path`, `temp_sibling_keeps_extension` |
| Progress parsing | `convert.rs` · `parse_progress_computes_percentage` |
| A file that is not audio is rejected with a usable reason | `probe.rs` · `a_stream_without_rate_or_channels_is_not_audio`, `probe_error_reports_what_ffprobe_said`, `probe_error_prefers_the_loader_error_over_its_own_context` |
| The bundled binaries link only against system libraries | `sidecar.rs` · `sidecars_are_self_contained` (macOS; the CI guard) |
| A broken sidecar says what the loader said | `sidecar.rs` · `reports_what_the_loader_said`, `falls_back_to_the_exit_status` |
| ALAC and AAC share the `.m4a` extension; AIFF is the default | `models.rs` · `target_format_extension_maps_containers`, `target_format_pcm_and_player_flags`, `target_format_default_is_aiff` |
| The list adopts the output and drops the old path | `librarySync.test.ts` · `mergeConverted` — "replaces an in-place conversion (same path) with its re-analysis", "drops the old source path on a format change and adds the output" |

Format fixtures for a dev run — 48 kHz, 96 kHz/24-bit, FLAC, MP3, AAC, WAV — are
generated by `scripts/dev-library.py` under `Formats/`.

## Keeping this honest

- **The rules are derived from documented hardware limits, not measured.**
  [CDJ_TEST_MATRIX.md](CDJ_TEST_MATRIX.md) records what has actually played on a
  player, and the two cases the app exists for — `downsample-96-to-44` and
  `aiff-c-to-pcm` — are still untested on hardware, as is the CDJ-3000-only flag
  on FLAC and ALAC. A rule change should update that file's gaps as well.
- **`convert_tracks` has no test.** The pure helpers of `convert_file` do; the
  rename, the `replace_source` trash and the three cleanup branches do not, and
  those are the parts that move the user's files. Recorded in
  [TODO.md](../TODO.md).
- **Never bundle a Homebrew binary.** Regenerate the sidecars with
  `scripts/build-static-ffmpeg.sh` or the *Build ffmpeg sidecars* workflow, and
  verify with `otool -L`, `file` and `codesign -dv` before committing.
- A new target format touches four places at once: `TargetFormat` and its
  `extension`, `build_args`, the settings UI, and the compat rules that decide
  what the format is worth.
