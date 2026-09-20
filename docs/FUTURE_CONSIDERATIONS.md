# Future considerations

A roadmap of ideas for rekord-lib, most of them collected by reading a
comparable open-source project — called *the reference project* below — that
solves the adjacent half of the same problem with the same stack (Tauri 2 +
Rust + SQLite, local-first, MIT). It stops where we start (it does not repair
files) and continues where we stop (it writes the Rekordbox export database
onto the USB drive itself), so the overlap is small and the lessons are cheap.

This is a list of *considerations*, not commitments. Nothing here is scheduled,
and several entries exist mainly so the reasoning is written down once.

## How to read this

Items are grouped in tiers and carry a stable ID (`A1`, `B3`, …) so a CHANGELOG
entry, commit or issue can reference one. Every item states what it is, why it
would be worth doing, a rough size, and any blocker.

Sizes are deliberately coarse: **S** ≈ a day, **M** ≈ a few days, **L** ≈ a
week or more, **XL** ≈ open-ended.

**An item that has shipped leaves this file**, in the release that ships it.
This is the list of what is still open; `CHANGELOG.md` is the record of what
happened, and a part that shipped without the rest of itself moves to
[TODO.md](../TODO.md) with the condition that would revive it. What stays behind
here is the id, in [Shipped](#shipped) at the end, so an older commit, document
or issue can still resolve one — and so no id is ever reused. A tier whose
entries have all shipped disappears with them and comes back when it has an open
item again.

| Tier | Theme |
| --- | --- |
| [A](#a--interoperability) | Interoperability — getting the library out of the app |
| [B](#b--analysis-quality) | Analysis quality |
| [D](#d--performance) | Performance |
| [E](#e--security-and-distribution) | Security and distribution |
| [F](#f--documentation-and-process) | Documentation and process |
| [G](#g--reach-and-test-depth) | Reach and test depth |
| [H](#h--long-term-not-committed) | Long-term, not committed |
| [I](#i--interface-and-playback) | Interface and playback — what the app looks like and how it plays |
| [J](#j--metadata-sources) | Metadata sources — what the databases are asked for and what comes back |

---

## A — Interoperability

The library is prepared inside rekord-lib and then has to leave it. The XML
export (A2) carries the playlists, the tempo and the grid across into
Rekordbox; what is left is the way back in, and the marks the export has no
source for.

### A3 · Read an existing `rekordbox.xml`

**Now unblocked.** A2 shipped, and with it a writer whose field handling A3 can
read back — plus `scripts/rekordbox-reference.py`, which already parses the half
of the format that matters for a library import.

**What** — the other direction: adopt an existing Rekordbox collection instead
of asking the user to start from an empty library.

**Why** — lowers the barrier for anyone who already has a curated collection,
and it hands us a reference set of BPM and key values to measure our own
detection against (see [DSP_BENCHMARK.md](DSP_BENCHMARK.md)).

*Size: M · A2 shipped the writer it would read back*

### A4 · Cue points — hot cues and memory cues

**What** — a mark concept: a position on a track that the app can set, name and
move, in the two kinds Rekordbox and the players tell apart —

- **hot cues**, the lettered marks a player jumps to on a button press, each
  with a colour of its own, written as `<POSITION_MARK … Num="0">` through
  `Num="7"` for A to H;
- **memory cues**, the unlettered marks the player steps through with its cue
  buttons, written with `Num="-1"`.

In storage and in the export they are one row and one element separated by a
single field, and they are still worth naming apart: a DJ sets them for
different reasons, and a UI that offers "a cue" without saying which kind will
reliably produce the other one.

**Why** — it is the one thing A2 deliberately left out, and it left the reason
behind: *"Cue points are not written, though the entry listed them. The app
has no concept of one, and inventing empty marks would put them in a player
where nobody set them."* The export half is therefore already built and already
proven against real Rekordbox files; what is missing is upstream of it.

The writing itself is one place: `export::rekordbox::track_xml`, which already
emits the `<TEMPO>` marker and is where a `<POSITION_MARK>` per mark would go.
That is the small end. The storage is the larger one: marks are their own table
next to `playlist_items` — a position, a kind, the hot cue letter where there is
one, a colour and a name — keyed the way that table is keyed, by `path` rather
than by a track id, and a new table is a `SCHEMA_VERSION` step, currently 10.
`tracks` is the wrong home: a track has one beat grid (B8) but any number of
marks.

Three things this needs beyond storage and UI. The round trip that keeps the
writer honest reads `<TEMPO>` and nothing else — `scripts/rekordbox-reference.py`
has no mark element in it — so closing the loop means teaching the reader about
marks as well. That check is the only one in the export that did not come out of
the same head as the writer, and a cue feature that skips it is a cue feature
nobody can verify. It is also why the attribute names above are the one part of
this format we have *not* read off a file Rekordbox wrote: confirm them against
a real export that has both kinds of mark in it before writing any.

Somewhere to set them, which the track row is not: 112 px for a whole track puts
neighbouring marks inside the same pixel. The zoomed, playhead-following
waveform in I2 is the prerequisite, and B8 waits on the same one.

And be clear about where a mark actually arrives. Through A2 it reaches
Rekordbox, which is the realistic path; onto a CDJ without Rekordbox in between
it would need ANLZ files, which is H1. Worth saying in the UI rather than
letting someone assume the drive will carry them. How *many* arrive is a
hardware question rather than a format one — the lettered slots a player offers
differ by generation, and the CDJ-2000nexus in the matrix is not a CDJ-3000 —
so that belongs in F4 as a measured row, not in the export as an assumption.

*Size: L · completes A2 · needs I2's larger waveform to be settable · full
player support depends on H1*

---

## B — Analysis quality

### B8 · Move the beat grid

**What** — make the stored grid editable: drag its anchor onto the beat that is
actually there, say which beat is the downbeat, and correct a tempo that is
right about the period and wrong about the multiple, by hand.

**Why** — B3 shipped the grid as a *detected* value and nothing else.
`tracks.beat_offset_secs` plus the tempo is a full grid, and A2 writes it out as
`<TEMPO Inizio="…" Bpm="…" Metro="4/4" Battito="1"/>` — where `Battito="1"`
asserts that the anchor is the first beat of the bar, which is precisely the
part B3 did not detect. When the anchor lands on beat three, everything
downstream inherits it: the player's quantize, a beat jump, and every A4 mark
snapped to that grid. Today the app has no way to say so and no way to fix it.

A movable grid is also what makes A4 worth snapping: a cue on the beat is only
on the beat if the beats are where the music is.

**What it costs** — not a schema step; the column exists and the export path
exists. What is new is a way to *see* the grid and something to drag, and the
row waveform cannot carry either (see *"The beat grid is stored and exported,
but not drawn"* in [TODO.md](../TODO.md)). So this shares I2's larger waveform
with A4, and it needs an edit to survive a rescan — a hand-placed anchor is
user data and must not be overwritten by the next analysis, the way a pending
metadata edit is not overwritten by a rescanned tag.

*Size: M · storage and export exist · needs I2's larger waveform · a hand-set
grid must survive re-analysis*

---

## D — Performance

### D2 · Cursor pagination for very large libraries

**What** — page track rows from SQLite with a signed cursor instead of handing
the whole table to the frontend.

**Why** — the list is virtualized, so rendering is fine, but we still load every
row. The reference project pages, and signs the cursor so it cannot be replayed
against a different query.

*Size: M · only worth doing against a real complaint, not preemptively*

---

## E — Security and distribution

### E1 · Developer ID signing and notarization

**What** — replace ad-hoc signing with a real Apple Developer ID and notarize
the bundle.

**Why** — still the biggest first-run friction; every user has to be told about
the Gatekeeper workaround. Already flagged in `CLAUDE.md`. (The reference
project does not do this either — there is no shortcut being missed here, just a
cost.)

*Size: M · needs a paid Apple Developer account*

---

## F — Documentation and process

The area where the reference project was clearly ahead, and where the return per
hour was the best of anything on this list. They maintain fourteen documents
under `docs/`; we had a README, a styleguide and `CLAUDE.md`. F1, F2, F3, F6 and
F7 closed that gap — the index is [`docs/README.md`](README.md).

### F4 · CDJ hardware test matrix — **started**

**What** — [`docs/CDJ_TEST_MATRIX.md`](CDJ_TEST_MATRIX.md): which player models
and firmware versions were actually validated, with which app version and which
converted format, and the result. Every `warn` or `fail` row carries a fixed
block — symptoms, reproduction, context, artifacts, open questions.

**Status** — the file exists with its scenario catalogue, the rules for what a
row has to cover, and twelve `pass` rows: AIFF 16- and 24-bit through a
Rekordbox export on a CDJ-2000nexus, a CDJ-3000 and an XDJ-700, with covers and
tag fields reading correctly. Those came from field use, so firmware and exact
dates are missing and the rows say so.

The gaps are the interesting part now, and the file lists them: the two cases
the app exists for — `downsample-96-to-44` (the E-8305 case) and
`aiff-c-to-pcm` — have never been on a player, and neither has the
CDJ-3000/NXS2-only flag we put on FLAC and ALAC. Closing those needs a session
with deliberately chosen files rather than a normal set.

**Why** — this matters more for us than it does for them. Our entire promise is
"runs without error codes on every CDJ/XDJ", and right now that claim rests on
compatibility rules rather than on recorded evidence. Their matrix is also a
good reminder of how much only hardware finds: they discovered a firmware hang
caused by unaligned UTF-16 string slots that no test suite would have caught.

*Size: S to start, then ongoing*

---

## G — Reach and test depth

### G2 · Windows and Linux

**What** — build for the other desktop platforms. The reference project ships
deb, rpm, AppImage, macOS and Windows.

**Why** — reach. But it needs static ffmpeg sidecars per target, CI runners per
target, and a second and third platform to keep working. Recorded, not
scheduled — revisit if anyone actually asks.

*Size: XL*

---

## H — Long-term, not committed

### H1 · Direct USB export (PDB + eDB + ANLZ)

**What** — write the Rekordbox export database (`export.pdb`,
`exportLibrary.db`) and the analysis files (`DAT`/`EXT`/`2EX`) straight onto the
drive, so playlists, waveforms and beat grids appear on the player without
Rekordbox in the loop at all. This is what the reference project does, and it is
what would make rekord-lib end to end.

**Why not yet** — two reasons, and the first is the hard one.

**Blocked on hardware.** There is no CDJ/XDJ available to validate against, and
this is not a feature that can ship on unit tests. The reference project found
real firmware hang conditions — unaligned UTF-16 string slots in the track rows,
stacked Unicode combining marks, strings mixing too many scripts — only by
putting sticks into actual players. Shipping a database writer that has never
touched hardware would be a good way to brick someone's set.

**And it is genuinely large.** Their PDB writer is around 300 KB of Rust, with
another 500 KB of diagnostics and repair code around it, built over months
against real drives.

If hardware becomes available, the sane staging is:

1. read-only USB *inspection* first — parse an existing drive and report what is
   on it, which is useful on its own and risks nothing;
2. ANLZ generation (the beat grid and the waveform it needs, B3 and B6, are
   in place);
3. PDB writing behind an explicit experimental flag;
4. timestamped pre-write backups from the very first write (C1), never bolted on
   afterwards.

And build on the existing open format work — [rekordcrate][rc] and Deep
Symmetry's [crate-digger analysis][cd] — rather than reverse-engineering from
zero.

*Size: XL · blocked on CDJ/XDJ hardware · the groundwork it depended on
(A1, B3, B6, C1) has shipped*

[rc]: https://github.com/Holzhaus/rekordcrate
[cd]: https://djl-analysis.deepsymmetry.org/

---

## I — Interface and playback

What the app looks like while it is being used, and what it does while a track
is playing. Everything here is small next to the tiers above and none of it is
speculative — each entry is something a person using the app asked for after
looking at it.

### I2 · Settings for playback

**What** — a settings section for the player: how the waveform is shown (larger,
and scrolling with the playhead rather than static), and a volume control.

**Why** — B6 shipped a waveform *preview*, sized and shaped for a player bar.
Reading a track while it plays is a different job, and volume does not exist at
all today: the only way to change it is the system mixer.

Two different costs hide in one item, and they should probably split. Volume is
a property on the `<audio>` element plus a settings key — small. A waveform that
follows the playhead is a per-frame redraw against the audio clock, where the
row waveform is a static overview drawn once from a stored table; that is a new
drawing path, not a bigger version of the existing one. The stored waveform's
resolution also has to be enough for a larger view, and that is
`waveform::ALGO_VERSION` territory — changing it invalidates every stored
waveform, which the cache rules require to be deliberate.

*Size: M · touches B6's stored waveform*

### I6 · The selection's actions do not belong in the header

**What** — "Edit metadata", "Convert selection", "Add to playlist" and "Delete"
appear in the header the moment something is selected, and leave again when the
selection is cleared. They need somewhere else to live.

**Why** — two complaints, one cause. The header fills up: with a selection it
carries eight controls plus the gear, on a window that also has to hold a logo.
And because the row is laid out left to right, the buttons that are *always*
there — "Scan library" and "Duplicates" — jump to the right as the selection
ones appear. A control that moves when you select a row is a control you have to
find again, and it is the one you were about to click.

It is also what made 0.8.1's unreachable menu possible: a dropdown anchored to a
button inside a 64 px sticky header has nowhere to open, and no amount of
placement rules fixes the fact that the anchor itself moves. I5 removed the
worst case by making that one a dialog, which needs no anchor at all — but it
removed the symptom, not the cause. Three of the four buttons still move, and
the one that is left with a menu is the column chooser.

**What the answer has to satisfy**, rather than what it is — that is the
decision this entry defers:

- The always-present controls do not move when a selection appears.
- The actions are near what they act on. A selection lives in the table.
- There is room for a menu to open from them, downward, without leaving the
  window (the Downward Menu Rule in `DESIGN.md`).
- Nothing is added that is only visible while something is selected *and* only
  in one grouping — the table has four.

A bar that appears at the bottom of the table over the selection is the obvious
candidate and the one to argue against first, since the app has no bottom bar
today and a new persistent region is a bigger change than it looks.

*Size: M · blocks nothing; the picker it used to block became a dialog in
0.10.0 and no longer waits on it*

---

## J — Metadata sources

What the app asks MusicBrainz and Discogs for, and how much of the answer it
actually uses. Distinct from the tiers above because the question is neither
analysis nor interface: the data exists in a remote database and the only
decision is which parts of it we are willing to put in front of the user.

### J1 · Fill more than four fields from Discogs

**What** — `discogs::aggregate` reads four keys out of a search result and turns
them into chips: `style`/`genre`, `year`, `label`, `country`. A search result
carries more that maps onto fields the editor already has:

- `catno` → **catalog number**. The field is in `TrackMetadata`, in the editor
  form and in the tag writer, and it is the only one of the ten with no
  suggestion source at all — neither `parse_filename` nor `MbCandidate`
  produces one, so today it is hand-typed or empty.
- the result's `title`, which is `"Artist - Release Title"` → **album** and
  **album artist**.
- the release's tracklist → **title** and **track number** of the actual track.
  This is the only one that needs a second request (`/releases/{id}`); search
  results describe the release, not its tracks.
- `cover_image` → the **cover**, as a fifth `CoverInput` case next to the
  MusicBrainz one.

**Why** — the four fields we fill are the four *optional* ones. The four that
`is_complete` requires — title, artist, album, album artist — are served only by
the filename guess and MusicBrainz, and Discogs is where an underground or
Bandcamp release is more likely to be documented at all. A track that stays
marked *metadata incomplete* stays that way for fields Discogs could answer.

**The decision that comes before the code.** Chips are aggregated across up to
25 releases, so a genre from one and a year from another can be combined into a
release that never existed. For the optional fields that is deliberate and
useful — a vocabulary to pick from. For album, album artist and catalog number
it is not: those three are only right *together*, and a per-field chip quietly
invites a mismatch that reads as authoritative. So the honest shape is probably
not more chip rows but a **Discogs candidate** alongside `MbCandidate` — one
release, applied as a set, with the aggregate kept for the fields where mixing
does no harm. Whichever way that goes, it settles how the tracklist lookup and
the cover attach themselves, because both hang off a chosen release rather than
off a search.

**What it costs.** The catalog number alone is a chip list, a `SUGGESTION_KEY`
entry and a test — small enough to do on its own and worth having either way.
The candidate model is the real item. The cover is separate again: remote bytes
are untrusted input, so it goes through `metadata::artwork::process_cover` like
every other cover and through `/security-review` before it ships.

*Size: S for the catalog number · M for the candidate model · M for the cover,
and that one needs `/security-review`*

---

### J2 · OAuth, once the user's own Discogs collection is in scope

**What** — the full OAuth 1.0a flow: request token, browser authorization,
per-user access token, HMAC-SHA1-signed requests. Discogs' third form of
authentication, next to the anonymous search and the credential 0.9.0 stores.

**Why not now** — measured 2026-08-26, it buys nothing the app currently wants:

- **Not the rate limit.** 60 requests per minute, throttled per source IP —
  identical to a personal access token, which is a string somebody copies rather
  than a flow somebody completes.
- **Not the data.** Genre, year, label and country come from
  `/database/search`, which is public and answers anonymous callers.
- **Not the secret.** OAuth needs the consumer secret *in the client*. In a
  distributed desktop app that is a public secret whichever way it gets there;
  OAuth makes shipping it the intended design rather than a real protection.

**What makes it right** — the moment the app wants a resource that belongs to
the *user* rather than to the catalog. The concrete one is their **Discogs
collection**: "do I already own this release", or preferring metadata from a
copy they have catalogued over the global best guess. Wantlist and marketplace
are the same shape. None of that is reachable with a key/secret pair, and no
amount of rate limit substitutes for it — that is the day this stops being
avoidable work and starts being the only way.

**What it costs then** — request signing, a callback (a loopback HTTP server, or
the out-of-band verifier code pasted back into the app), two more Keychain items
for the token pair, and `/security-review`, because the callback is a local
listener taking untrusted input. The `Credential` enum in
`metadata/discogs.rs` is where the third form would go; `secrets.rs` already
stores one form at a time, which is the shape this needs.

*Size: M, and it needs `/security-review`*

---

## Deliberately not adopted

Things the reference project does that we should keep *not* doing. Written down
so the question does not come back.

- **Downloading an analysis engine at runtime.** Their optional essentia.js
  engine fetches npm tarballs from `registry.npmjs.org` at runtime with no
  checksum or signature verification, then shells out to a `node` binary whose
  path an environment variable can redirect. It also requires Node on the user's
  machine, which breaks our rule that the app runs on a clean Mac with no
  dependencies. If we ever want a second engine, it gets linked in, not
  downloaded.
- **Monolithic modules.** `service/repair.rs` is 304 KB, `export_helpers/mod.rs`
  is 241 KB, `service/mod.rs` is 187 KB — single files each. Our largest Rust
  file is a small fraction of that. Keep it that way.
- **Shipping without CI.** Their only workflow is `release.yml`; nothing runs
  their tests on push or pull request, despite an extensive test suite existing.
  Our `ci.yml` gate — typecheck, both test suites, on every push and PR — stays.
- **Unsigned updates.** Their update path is a GitHub release check plus a
  manual download. Our minisign-verified Tauri updater is strictly better and
  must never be traded away for convenience.
- **A vanilla-JS frontend.** Their `main.js` is roughly 50 KB and `styles.css`
  roughly 70 KB, in one file each. Our token-driven React and Tailwind setup is
  the reason new UI does not drift from the design system — a deliberate
  difference, not a gap.

---

## Shipped

The entries themselves are gone — what they became is in
[`CHANGELOG.md`](../CHANGELOG.md), and the parts that shipped without the rest
of themselves are in [TODO.md](../TODO.md) as `C1a`, `C1b`, `C2a` and the
undrawn beat grid. Only the ids stay, so that an older commit, document or
issue still resolves one and so that none of them is ever reused.

| Tier | Shipped |
| --- | --- |
| A — Interoperability | **A1** playlists in the app · **A2** Rekordbox XML export |
| B — Analysis quality | **B1** key detection · **B2** fractional BPM and an exposed confidence value · **B3** beat grid, without the downbeat · **B4** analysing more than one window — *measured and rejected*, see TODO.md · **B5** configurable BPM range · **B6** waveform preview in the player bar · **B7** benchmark against `stratum-dsp`, see [DSP_BENCHMARK.md](DSP_BENCHMARK.md) |
| C — Robustness and data safety | **C1** backup and undo before destructive writes · **C2** relocate a moved library folder · **C3** persistent event log · **C4** visible failed-files list · **C5** pause and resume long scans · **C6** sidecar self-test at startup · **C7** invalidate the cover thumbnail cache after a write · **C8** undo restores the original cover bytes · **C9** "no tempo" is an answer worth storing |
| D — Performance | **D1** core- and memory-aware worker budget · **D3** progressive per-field row updates during the scan |
| E — Security and distribution | **E2** harden Bandcamp download handling · **E3** narrow the `assetProtocol` scope · **E4** dependency auditing in CI · **E5** move the Discogs secret into the Keychain |
| F — Documentation and process | **F1** functional docs per feature area · **F2** [COMPARISON.md](COMPARISON.md) · **F3** [CONTRIBUTING.md](../CONTRIBUTING.md) · **F5** severity marking in the changelog · **F6** [COMMANDS.md](COMMANDS.md) · **F7** [TODO.md](../TODO.md) |
| G — Reach and test depth | **G1** end-to-end tests, in two layers, see [TESTING.md](TESTING.md) |
| I — Interface and playback | **I1** an expanded group looks expanded · **I3** edit a playlist in a dialog · **I4** the player says which album · **I5** "Add to playlist" is a dialog · **I7** an action that changed something says so · **I8** playlists are their own view |
