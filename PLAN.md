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

---

## Outcome

Done, and the plan's two guesses were both wrong in the useful direction.

**The year: safe, and measured before the port rather than after.** Written with
0.22 and with 0.25 into all five formats, read back with `ffprobe` — the bundled
one, because a library must not judge its own output:

| Format | 0.22 writes | 0.25 writes |
| --- | --- | --- |
| AIFF, MP3, WAV (ID3v2) | `date=1997` | `date=1997` — identical |
| M4A | `date=1997` | `date=1997` — identical |
| FLAC (Vorbis) | `YEAR=1997` | `DATE=1997` — **changed** |

`DATE` is the field the Vorbis comment spec recommends and `YEAR` the legacy
alias, so the change is toward the standard. The two facts that make it safe
were measured too: 0.25's `date()` finds a year in the legacy field as well, so
files tagged by 0.9.2 still read; and re-writing one **replaces** it rather than
leaving `YEAR=1997` beside `DATE=2001`. `remove_date()` clears both, which is
why the clear path uses it instead of `remove_key(ItemKey::Year)`.

**The country: a bug nobody knew about.** `ItemKey::from_key(tag_type,
"RELEASECOUNTRY")` resolved to `ItemKey::Unknown(..)` in 0.22 — the crate had no
`ReleaseCountry` variant at all — and `insert_text` of an unknown key returns
false and writes nothing. The app ignored the return value. So a country the
user typed reached the database and the Rekordbox export and **never reached the
file**, in every release up to 0.9.2. 0.25 has the key, `insert_text` returns
true, and `ffprobe` reads it back. Fixed as a side effect, and called out in the
changelog because it changes what lands in files.

**The cover: as corrected, mechanical.** `Picture::unchecked` is a builder now;
three call sites, no behaviour change, nothing to decide.

## One thing the upgrade brought with it

`lofty` 0.25.2 panics — `attempt to subtract with overflow` at
`id3/v2/write/chunk_file.rs:105` — when it *rewrites* an existing ID3v2 chunk in
a RIFF file and the new tag is larger than the file's whole audio stream. It
subtracts where it should add.

Unreachable with real audio, and that was checked rather than reasoned: a 300 KB
cover embedded into the 5 MB `plain.wav` fixture comes out with the right
duration and size. Reachable with a test fixture of 64 samples, which is what
`wav_bytes()` was and why `an_undo_puts_the_original_bytes_back` failed. The
fixture now carries a second of silence, the reason is written above it, and
`a_cover_larger_than_the_audio_still_panics_upstream` pins the bug with
`#[should_panic]` — so the day lofty fixes it, the canary fails, and the fixture
can shrink again.

Not yet reported upstream. Worth doing, and it is the maintainer's call whether
to open it.
