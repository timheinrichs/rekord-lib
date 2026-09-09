# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: digital DJs with a purchased collection** — hobby to semi-professional,
buying from Bandcamp/Beatport, playing on club-installed Pioneer CDJ/XDJ players
they do not own. Their situation is the gap between the download folder and the
gig: a set of freshly bought files, a USB stick, and a player that either accepts
them or shows an error code in front of an audience. Their job is
*"turn a folder of purchases into a stick that plays"* — repair what players
refuse, complete the tags, remove the duplicates, keep the collection in one
place.

When a decision is close, it is decided for that user. Gigging professionals and
the wider Rekordbox audience are welcome, not the target.

## Product Purpose

rekord-lib prepares a music library so it plays on **every** Pioneer CDJ/XDJ
without error codes and stays clean in Rekordbox: conversion of what players
reject (resampling above 48 kHz, uncompressed PCM instead of AIFF-C, 16/24-bit),
a metadata editor with suggestions and required-field checks, duplicate detection
across formats and filenames, playlists, a `rekordbox.xml` export, and Bandcamp
purchases downloaded straight into the library. It runs locally on macOS and
uploads nothing.

**Success is defined as: no error code at the player** — the files are
demonstrably correct *before* the stick is in the machine. Reach, downloads and
donations are not the measure.

**Near-term priority: one app that runs.** One target, macOS on Apple Silicon,
finished and dependable — that comes before any second platform. Splitting the
attention across two operating systems before the app stands would cost the
thing success is measured by.

**Long-term direction (an aspiration, and revisable):** to become the better
Rekordbox — a *one-for-all* application that replaces what people do in
Rekordbox today, including the performance-adjacent preparation (cues, an
editable beat grid, set-level preparation), writing the player database itself
rather than handing off, supporting Denon/Engine DJ players alongside Pioneer,
and eventually Windows. It is recorded so future work knows which way the
product is allowed to grow — not as a commitment, a sequence, or a promise to
anyone. It binds no current work, it may change, and no shipped claim may
anticipate it.

> So `docs/COMPARISON.md` ("Rekordbox is not a competitor", `G2`: no plan for
> Windows/Linux) and `CLAUDE.md`'s macOS/Apple-Silicon target are **correct as
> they stand** and need no edit. They describe the product and the near-term
> plan. They only need revisiting if and when the direction above turns into
> planned work — decided deliberately, never as a side effect.

## Positioning

**We fix the files; the player never sees a format it refuses.** The
differentiator is not speed but *the verdict*: the app says which files a player
would reject and why, by rules that are written down
(`docs/CONVERSION.md`) and with hardware validation recorded per model
(`docs/CDJ_TEST_MATRIX.md`). Tag editors do not judge player compatibility;
Rekordbox plays what it is given; the tools that write the USB database
themselves start where preparation ends. Duplicate detection works on the audio
(length, acoustic fingerprint, name similarity), not on filenames.

The direction above extends that position along the chain — toward owning the
whole path from purchase to player — rather than sideways into a different
category.

## Operating Context

- One central **managed library folder**, scanned recursively; the track
  database is SQLite, so the list is on screen at startup and a rescan re-reads
  only changed files.
- The chain today: purchase → library → scan/analysis → conversion + metadata
  repair → playlists → `rekordbox.xml` → Rekordbox → USB → player. rekord-lib
  does **not** write the USB drive today (no `export.pdb`, no ANLZ files;
  tracked as **H1**).
- External services are contacted only when a feature asks: MusicBrainz and
  Discogs for suggestions (no account needed; an optional Discogs token in the
  macOS Keychain only raises the rate limit), Bandcamp for login, collection sync
  and downloads.
- Installation is a `.dmg` for Apple Silicon, ad-hoc signed, so Gatekeeper warns
  once on first launch; the app updates itself from then on.
- Real work happens on large collections: filter and search, grouping by album,
  label, folder or playlist, multi-select with shift ranges, a virtualized list.

## Capabilities and Constraints

- **Shipped today:** managed library + cancelable scan, compatibility verdicts,
  conversion (default AIFF), metadata editor incl. bulk edit and undo, cover
  artwork with `cover.jpg` fallback, duplicate groups with cached fingerprints,
  playlists as an explicit order, Rekordbox XML export with tempo/key/one tempo
  marker, Bandcamp login/sync/download, self-update.
- **Deliberate non-capabilities today**, and any claim otherwise is a defect:
  no USB/player database writing (**H1**), no musical key written into files
  (detected and kept in the database only — the detector agrees with Rekordbox
  about a third of the time), no performable beat grid (phase only, first
  downbeat not detected — **B3**), no Windows or Linux build (**G2**), no upload
  of the library.
- **Platform:** a standalone macOS desktop app (Tauri 2 + React 19 + Rust) for
  **Apple Silicon only** — the bundled `ffmpeg`/`ffprobe` sidecars exist for that
  one target, and it stays the only one until the app is finished on it. The
  bundle must keep running on a clean macOS install with no Homebrew and no
  installed dependency. Windows exists in the long-term aspiration only; it is
  **not** a current constraint to design around, and nothing is built or tested
  twice for it today.
- **Undecided / open, and deliberately so:** whether the full-replacement
  direction is pursued at all and how far it reaches, when or whether
  Denon/Engine DJ support starts, and whether the app writes the player database
  before it has been validated on real hardware (the blocker there is hardware,
  not effort). Roadmap in `docs/FUTURE_CONSIDERATIONS.md`; consciously rejected
  work, with the condition that would reopen it, in `TODO.md`.
- **Terminology to keep:** *compat* (the compatibility verdict), *managed
  library*, *duplicate group*, *conversion*, *metadata incomplete*,
  *beat grid marker*, *sidecar*.

## Brand Commitments

- Name is lowercase **rekord-lib**. Logo: square brackets `[ ]` (code library,
  the `-lib`) around a four-bar waveform, two-tone with the violet accent —
  never distorted, recolored, or with effects added; assets in
  `src/assets/brand/`.
- Voice is **technical, precise, calm** — a tool for DJs, not a playful consumer
  product. Sentence case, no Title Case, no ALL CAPS. English throughout the
  product and repository.
- The visual identity is fixed and token-bound (`src/styles/tokens.css`,
  `docs/brand/STYLEGUIDE.md`), dark by default. Status color means
  compatibility state, never decoration.
- **Free and MIT-licensed**, no account requirement, no capability behind a
  paywall. Donations are voluntary (PayPal) and never a gate.
- **Local-first:** the library never leaves the machine. Secrets live in the
  macOS Keychain, and credential material — including the "not secret" half like
  a consumer key — never travels over IPC or reaches the DOM.

## Evidence on Hand

- **Tempo detection, measured:** 87.1 % within ±2 BPM over 2180 reference
  tracks, against 83.1 % for an off-the-shelf crate at roughly 70× the cost —
  `docs/DSP_BENCHMARK.md`. That file also holds the limits and the questions the
  measurement could not settle.
- **Hardware validation:** AIFF output has played on a CDJ-2000nexus, a CDJ-3000
  and an XDJ-700 via a Rekordbox export, with covers and tags reading correctly.
  The two cases the app exists for — resampling 96 kHz and converting AIFF-C —
  have **not** been on a player yet (`docs/CDJ_TEST_MATRIX.md`).
- **Rules, not vibes:** compatibility rules derive from Pioneer's documented
  format limits, not from measurement (`docs/CONVERSION.md`).
- **Assets:** brand SVGs (`src/assets/brand/`), app screenshot
  (`docs/media/screenshot.png`), per-area documentation index
  (`docs/README.md`), changelog per version.
- **Absent — must never be fabricated:** user numbers, download or adoption
  figures, testimonials, reviews, press, case studies, named users, benchmark
  numbers other than the ones in `docs/DSP_BENCHMARK.md`, and any hardware claim
  not listed in `docs/CDJ_TEST_MATRIX.md`.

## Product Principles

1. **Deliver the verdict before the stick is in the machine.** Saying which file
   a player would refuse, and why, is the product; conversion is the
   consequence.
2. **Never claim more than has been measured or played.** "What we do not do"
   is stated first and kept current; an unvalidated claim is a defect, and every
   number lives in the one document that measured it.
3. **Local-first, account-optional.** The collection stays on the machine; a
   third-party service is contacted only when a feature the user invoked needs
   it, and credentials stay in the backend.
4. **No stale verdict.** Derived values are recomputed rather than stored, and
   every cache states what invalidates it — the app is trusted because it can
   re-derive, not because it remembers.
5. **Free, MIT, ungated.** No paid tier, no login wall, no capability withheld;
   the way the product grows is along the chain toward the player, never into a
   payment gate.

## Accessibility & Inclusion

Nothing beyond the styleguide is established as binding: contrast on small
technical text, and **reduced motion is mandatory** — every animation switches
off under `@media (prefers-reduced-motion: reduce)` in `index.css`, and a new
one is added to that rule. Full keyboard operation and VoiceOver support are
**explicitly open, not committed**; the code already carries ARIA roles in
places, which is a partial state rather than a standard.
