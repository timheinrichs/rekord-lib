# Plan — lofty 0.22 → 0.25

## Version

**PATCH.** A dependency upgrade with no user-facing change is internal work. The
whole point of the plan is that the number stays a PATCH: if the upgrade changes
which tag frame a year lands in, that *is* user-facing, and it is a defect
rather than a feature.

## Why, and why not for the reason you would guess

Not for the advisory. RUSTSEC-2024-0436 (`paste`, unmaintained) is the reason
this came up, and checked against crates.io, **`lofty` 0.25.2 still depends on
`paste`** — the advisory survives the upgrade. It is accepted in
`src-tauri/.cargo/audit.toml` and stays accepted either way.

The actual reason is that `lofty` is three minor versions ahead, it is the crate
that reads and writes every tag this app exists to fix, and the distance only
grows. Doing it deliberately now beats doing it under pressure later.

## What actually breaks

Measured, not estimated: `lofty = "0.25"` plus `cargo check` gives **15 errors
in two files** (`src/metadata/read.rs`, `src/metadata/write.rs`), from three
causes.

### 1. `ItemKey` is taken by value (11 errors) — mechanical

`get_string(&ItemKey::X)` → `get_string(ItemKey::X)`, same for `remove_key`.
`ItemKey` became `Copy`. No behaviour to think about.

### 2. `Accessor::year`/`set_year` are gone (2 errors) — **the risk**

Replaced by `date()`/`set_date()` over a new `Timestamp { year: u16, month:
Option<u8>, day, hour, minute, second }`.

This is the one that needs proving rather than porting, because the app's job is
that *other* programs read these tags correctly — Rekordbox above all. Today:

- read: `tag.year()` → `Option<u32>` → `to_string()`
- write: `md.year.parse::<u32>()` → `tag.set_year(y)`, and `clear_empty` removes
  `ItemKey::Year`

The app models a year as a free-form `Option<String>` (`models.rs:68`), and
Discogs hands back things like `"1997-05"`, which `parse::<u32>()` already drops
on the floor. So the *app-visible* type does not change. What might change is
**which frame the value lands in**: `ItemKey::Year` is TYER on ID3v2.3 and TDRC
on 2.4, and a `Timestamp`-shaped setter may well write the recording-date frame
instead. A file that Rekordbox read a year from before and does not after would
be a silent regression in exactly the thing this app promises.

**So this is verified, not assumed** — see Verification below.

### 3. `Picture::new_unchecked` is gone (1 error) — needs a decision

The remaining constructors (`from_jpeg`, `from_png`, `from_reader`) validate and
return `Result<_, PictureParseError>`. `apply_cover` in `write.rs:288` cannot
fail today; after the upgrade the cover path can.

Better behaviour — an invalid image stops being embedded as garbage — but it
needs a choice, and it is the maintainer's:

- **fail the whole metadata write** (loud, but loses the text edits over a bad
  cover), or
- **skip the cover, write the rest, and record it in the event log** (the log
  exists for exactly this, and the app already reports per-file write failures).

Recommendation: the second. A bad `cover.jpg` next to a track should not cost
the user their tag edits, and the event log is the established place for "this
one thing did not work".

## Steps

1. Bump `lofty = "0.25"`, `cargo update -p lofty`.
2. Fix cause 1 across both files — mechanical, no decisions.
3. Port the year through `date()`/`set_date()`, keeping the app's `Option<String>`
   contract: parse a leading four-digit year, drop what is not that, exactly as
   `parse::<u32>()` does today. Preserve the `clear_empty` semantics.
4. Port `apply_cover` to a checked constructor and thread the failure per the
   decision above; pick the constructor by the mime the caller already has
   (`CoverImage` carries it), falling back to `from_reader`.
5. Re-read `docs/METADATA.md` against the result. It documents what the app
   writes and is the document that becomes wrong first if a frame moves.

## Verification

The four gates are necessary and nowhere near sufficient here.

- **The frame-level proof, and this is the point of the whole plan.** For each
  format the app writes — AIFF, MP3, FLAC, WAV — take a file, write a year with
  the current build and with the upgraded one, and compare the resulting tag
  *frames* with a tool that is not lofty: `ffprobe -show_entries format_tags`
  from the bundled sidecar, since it is already in the repo and reads what other
  programs read. Identical frames, identical values, or the port is wrong.
- **Round-trip on real files.** The generated dev library (`scripts/dev-library.py`)
  has an untagged file and tagged ones; real purchases are the harder case
  because their tags are messier. Read → write → read with both versions and
  diff the `TrackMetadata` structs.
- **`npm run e2e`.** `e2e/scan.spec.ts` writes a detected tempo into a real file
  and `metadata.e2e.test.tsx` covers the editor's write path, so the suite does
  exercise real tag writing — it is the closest thing to a regression net here.
- **`cargo test`** for the Rust unit tests around `metadata::{read,write}`.
- **A running app**, on copies in `.dev/`: edit a year, edit a cover, convert a
  file, and look at the result in something else.

## What would stop this

If the year cannot be made to land in the same frame as before, the upgrade
waits. A tag this app writes wrongly is worse than a dependency three versions
behind, and `paste` — the thing that started this — is not fixed by the upgrade
anyway.
