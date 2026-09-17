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
in two files** (`src/metadata/read.rs`, `src/metadata/write.rs`) — fourteen real
ones plus the "could not compile" summary — from three causes. **Twelve of the
fourteen are mechanical.** Two are not, and they are the whole reason this is a
plan.

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

### 3. `Picture::new_unchecked` was renamed (1 error) — mechanical after all

**This entry was wrong when first written, and the correction matters more than
the entry.** It said the only remaining constructors validate and return a
`Result`, so the cover path could now fail and somebody had to decide what a bad
image should cost. That was a wrong reading of the crate: `Picture::unchecked`
still exists in 0.25, as a builder rather than a function, and it returns a
`Picture` with no `Result` in sight:

```rust
Picture::unchecked(bytes)
    .pic_type(PictureType::CoverFront)
    .mime_type(mime)
    .build()
```

So the port is one call site rewritten into builder form, `apply_cover` keeps
its signature, and no behaviour changes. The validating constructors
(`from_jpeg`, `from_png`, `from_reader`) are an *addition*, not a replacement.

Worth keeping the analysis that came out of the mistake, because it is the thing
to weigh if validation is ever adopted deliberately: a cover reaches
`apply_cover` from five places (`CoverInput`), and they do not deserve the same
treatment. `Musicbrainz` is a download and `File` is user input — validating
those would be a gain, and `CLAUDE.md` asks for exactly that of third-party
content. But `Data { base64 }` **is the undo path**: bytes the app itself
captured from a file it is about to overwrite. Rejecting there would mean undo
silently failing to restore the artwork it exists to restore, on a file that was
fine before. That asymmetry is the argument, and adopting validation is its own
change with its own tests — not a side effect of an upgrade.

## Steps

1. Bump `lofty = "0.25"`, `cargo update -p lofty`.
2. Fix cause 1 across both files — mechanical, no decisions.
3. Port the year through `date()`/`set_date()`, keeping the app's `Option<String>`
   contract: parse a leading four-digit year, drop what is not that, exactly as
   `parse::<u32>()` does today. Preserve the `clear_empty` semantics.
4. Rewrite the one `Picture::new_unchecked` call into the builder form. No
   signature change, no new failure path.
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

## Nothing here needs deciding

Stated plainly because the first draft of this plan claimed otherwise: there is
no open question for the maintainer. Twelve of the fourteen errors are
mechanical, the thirteenth and fourteenth are the year, and the year is settled
by measurement rather than by preference — either it lands in the same frame or
the port is wrong. A decision only appears if that measurement fails, and then
it is about whether to wait, which is the section below.

## What would stop this

If the year cannot be made to land in the same frame as before, the upgrade
waits. A tag this app writes wrongly is worse than a dependency three versions
behind, and `paste` — the thing that started this — is not fixed by the upgrade
anyway.
