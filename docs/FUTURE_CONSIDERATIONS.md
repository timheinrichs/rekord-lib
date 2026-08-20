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

| Tier | Theme |
| --- | --- |
| [A](#a--interoperability) | Interoperability — getting the library out of the app |
| [B](#b--analysis-quality) | Analysis quality — BPM, key, beat grid, waveform |
| [C](#c--robustness-and-data-safety) | Robustness and data safety |
| [D](#d--performance) | Performance |
| [E](#e--security-and-distribution) | Security and distribution |
| [F](#f--documentation-and-process) | Documentation and process |
| [G](#g--reach-and-test-depth) | Reach and test depth |
| [H](#h--long-term-not-committed) | Long-term, not committed |

---

## A — Interoperability

The library is prepared inside rekord-lib and then has to leave it. Today that
handoff is "the files are correct now, go import them in Rekordbox", which
throws away everything the app knows beyond the tags.

### A1 · Playlists in the app

**What** — a playlist concept: container metadata (name, identity, timestamps)
separate from ordered membership rows (`playlist_id`, `track_id`, position), so
ordering is explicit and stable across add/remove instead of implied by a query.
That is the model the reference project uses and it is the right one.

**Why** — we have no playlist concept at all. It is also the prerequisite for
A2, which is the item that actually pays off.

New tables next to `tracks`/`edits` in `src-tauri/src/db/schema.rs`; the pure
ordering and membership logic belongs in `src/lib/` so it is testable the way
`src/lib/grouping.ts` is, not buried in a component.

*Size: M · prerequisite for A2, H1*

### A2 · Rekordbox XML export

**What** — write a `rekordbox.xml` collection (tracks, playlists, BPM, key, cue
points) that Rekordbox imports in one step.

**Why** — this is the highest-value item on the whole list. It covers the real
user need — *get my prepared library into Rekordbox without re-tagging
everything* — at roughly two orders of magnitude less effort than a PDB writer
(H1), because the format is XML, documented, and forgiving.

*Size: M · depends on A1*

### A3 · Read an existing `rekordbox.xml`

**What** — the other direction: adopt an existing Rekordbox collection instead
of asking the user to start from an empty library.

**Why** — lowers the barrier for anyone who already has a curated collection,
and it hands us a reference set of BPM and key values to measure our own
detection against (see B7).

*Size: M · depends on A2*

---

## B — Analysis quality

Baseline for the comparison. Our `src-tauri/src/audio/bpm.rs` decodes a 120 s
excerpt at 11.025 kHz starting 30 s in, builds a spectral-flux onset envelope
(FFT 512 / hop 64), autocorrelates it, refines the peak parabolically, and folds
octaves across 11 ratios weighted by a log-normal tempo prior centred at
140 BPM. Output: one integer BPM, or `None` when the peak is unconvincing.

The reference project uses the `stratum-dsp` crate (with essentia.js via Node
as an opt-in alternative) over the **full** track, and gets BPM **plus key plus
a full beat grid plus the first downbeat**.

Our DSP is the better-tested of the two — theirs covers engine selection, empty
input and a sine wave; ours covers click tracks, half/double-time traps,
silence and white noise — and ours deliberately returns nothing rather than a
wrong number. But it produces a single integer, and that is the gap.

### B1 · Key detection

**What** — musical key, written as Camelot or Open Key.

**Why** — the one piece of technical metadata DJs sort by that we do not
produce. `stratum-dsp` returns it alongside BPM, so it can be bought rather
than written. Feeds the metadata editor and the completeness rule in
`TrackMetadata::is_complete` (`src-tauri/src/models.rs`).

*Size: M*

### B2 · Fractional BPM and an exposed confidence value

**What** — keep the fractional part instead of rounding to `u32`, and surface
the confidence the detector already computes internally (today it only feeds
the `MIN_PEAK_CORRELATION` / `MIN_PEAK_RATIO` gate in `audio/bpm.rs`).

**Why** — Rekordbox stores fractional BPM; we throw the decimals away. And a
confidence value lets the UI say "detected, uncertain" and lets us refuse to
overwrite an existing tag with a weak guess — which matters, because a wrong
number written into thousands of files is worse than no number.

*Size: S*

### B3 · Beat grid and first downbeat

**What** — the beat positions, not just the tempo.

**Why** — required by anything that later writes ANLZ files (H1), and useful in
the player bar on its own.

*Size: M · prerequisite for H1*

### B4 · Analyse more than one window

**What** — two or three excerpts instead of the single 120 s window at 0:30,
with agreement between them feeding the confidence value from B2.

**Why** — one window is fast but blind to tempo changes and can be dominated by
an atypical section (a long breakdown, a half-time intro). The reference
project decodes the whole track; several windows get most of that robustness at
a fraction of the cost.

*Size: S · pairs with B2*

### B5 · Configurable BPM range

**What** — expose min/max BPM as a setting. Ours is hardcoded 60–200; theirs
defaults to 70–180 and comes from settings.

**Why** — a narrower range removes a whole class of octave errors for anyone
whose library sits in one genre.

*Size: S*

### B6 · Waveform preview in the player bar

**What** — render a downsampled waveform for the currently playing track.

**Why** — makes the built-in player actually useful for checking a file, and it
is the precondition for generating ANLZ waveform data later (H1). The
reference project splits this into a UI preview (2400 bins) and a much denser
detail resolution for the player files; the same split would apply here.

*Size: M · prerequisite for H1*

### B7 · Benchmark `stratum-dsp` against our detector

**What** — run both over the 21-track set we already have Rekordbox reference
values for (7/21 correct before the tempo prior, 15/21 after), and keep
whichever wins.

**Why** — if an off-the-shelf crate beats hand-written DSP, that is a win; if it
does not, we have documented evidence for keeping ours. Either way the DSP tests
in `audio/bpm.rs` stay — they test behaviour, not an implementation.

*Size: S · informs B1, B3*

---

## C — Robustness and data safety

### C1 · Backup and undo before destructive writes — **done**

**What shipped** — three things, after checking what was actually already in
place rather than what the comparison suggested:

- **Tag writes are undoable across restarts.** The undo history moved out of
  React state into the database (`undo_entries`, schema v3), and the snapshot is
  now taken *in the backend* from the files' real tags rather than from whatever
  the library view last displayed. `undo_last` restores and drops the entry in
  one step, so a failed restore does not lose the entry.
- **Covers survive an undo.** The old snapshot carried no cover at all, so
  undoing an artwork change restored the text and left the new cover in place.
  A write that replaces embedded artwork now captures the previous bytes
  (`CoverInput::Data`); a write that leaves the cover alone stores nothing, which
  is what keeps a 200-track bulk edit's undo entry small.
- **Conversion no longer unlinks the original.** `replace_source` used
  `std::fs::remove_file` on the user's own audio; it goes to the trash now, like
  every other delete in the app.

**What the comparison got wrong** — worth recording, because it is why this item
was smaller than it looked: deletions already went to the system trash
(`delete_files`, `delete_album`, `prune_empty_dirs` have used the `trash` crate
all along), and an undo for tag writes already existed — it was just in-memory
and session-only.

**What is left** (as follow-ups, not part of this item):

- **C1a** — the scan's BPM pass writes a tag into every file it detects a tempo
  for, with no undo record. It is additive by default (it only fills an empty
  BPM), but `force` overwrites an existing value. Undoing it through
  `write_metadata` would rewrite every tag in the file, which is a heavier
  operation than the write being undone — it needs its own narrow path.
- **C1b** — a conversion is still only reversible by hand: the original is in
  the trash and the output is on disk, but nothing ties the two together.

### C2 · Relocate a moved library folder instead of pruning — **done**

**What shipped** — a missing library folder is recoverable state now, and the
app offers to follow it:

- **Nothing is pruned on a folder that cannot be listed.** There were *two*
  paths that read an empty walk as "every file was deleted", and only running
  the app found the second one. The backend sweep no longer counts as full
  unless the root could actually be listed (`is_full_sweep`), and the
  frontend's incremental sync passes `null` rather than an empty listing into
  `diffAudioFiles`, which is where the rule now lives — an empty listing is
  evidence, an unreadable folder is not.
- **Re-pointing keeps track identity.** `library_relocate` rewrites the stored
  paths from `oldRoot/relative` to `newRoot/relative` wherever the file is
  really there, carrying the pending edits and cached fingerprints that hang off
  the path (`PRAGMA defer_foreign_keys` for the duration, since
  `fingerprints.path` references `tracks(path)`).
- **It never deletes.** Rows whose file is not under the new root — or whose
  path another row already holds — stay exactly where they are and are reported
  as skipped. This runs when the user is recovering data, so a full scan is what
  eventually prunes them, not the recovery itself.
- **Two ways in.** The library view shows a warning banner with "Locate
  folder…" instead of an empty list, and picking a different folder in the
  settings re-points the existing rows rather than starting over.

**What is left** (as a follow-up, not part of this item):

- **C2a** — dismissed duplicate groups are keyed by the smallest path in the
  group, so a relocate leaves those dismissals pointing at the old paths and
  the groups come back once. The rows themselves survive; only the "waved off"
  decision does not.

*Size: M*

### C3 · Persistent event log — **done**

**What shipped** — a log in SQLite (`events`, schema v4), a button in the shared
header, and one rule about what goes in it.

- **What is recorded** are the failures the app *survived*: a cache it could not
  read, rows it could not persist, a duplicate result it could not store, an
  undo entry it could not write, a detected tempo it could not save, a file it
  had to skip. Every one of them used to be an `eprintln!`, which in a bundled
  `.app` goes nowhere anyone will ever look — and every one of them explains
  behaviour that looks arbitrary afterwards (why was that file re-probed, why is
  that track missing, why did undo do nothing). Failures the user is already
  looking at — a conversion that reports its own error — stay where they are.
- **`events::record`** writes the row and prints the same line, so a `tauri dev`
  run still shows it inline. It is best effort by design: the log exists to
  explain a failure and must never turn a survivable one into a fatal one.
- **The panel** lives behind a header button, always reachable, with a dot only
  when something *unread* is a warning or an error — the marker is stored next
  to the events (`events_seen_id`), so it is bookkeeping for the table rather
  than a user preference. The whole log copies as text, which is the form a bug
  report needs.
- **Capped at 500 entries** (`MAX_EVENTS`), pruned on insert: a diagnostic
  record, not an archive, and nothing that grows with the collection.

**What is left** — the four `eprintln!` calls in `lib.rs` stay as they are: they
run during setup, and two of them are about the database that would have to
record them. `db::migrate` is in the same position.

Testing the panel turned up one more thing, fixed along the way: ffprobe
identifies a file by its extension as readily as by its contents, so four bytes
of text named `.flac` probed *successfully* as a FLAC stream with 0 Hz and no
channels — and landed in the library as a track that could never be played or
converted. `probe` now rejects a stream without a sample rate or channels, which
turns it into a skip with a reason instead of a row that fails at everything
later.

*Size: M*

### C4 · Visible failed-files list — **done**

**What shipped** — the non-fatal half was already true: a file that cannot be
probed is skipped and the run continues, verified end to end with a garbage
file and a truncated one in the folder. What was missing was every part of
*reported*, and it was missing in three places at once:

- **The reason was thrown away** at `analyze_path`, which turned an
  `AppResult` into an `Option` (`probe(...).ok()?`). It returns the error now,
  and every caller that drops a file says so through `record_skip`, which emits
  one `scan://skipped` event per file — the scan, the incremental sync, and a
  tag write whose re-read fails alike. A probe task that dies outright is named
  too, since its path travels with the join handle.
- **The reason was not worth reading.** ffprobe ran with `-v quiet`, so the
  message could only ever be `ffprobe exit Some(1):` — a Debug-printed `Option`
  and an empty stderr. It runs with `-v error` now and `probe_error` turns what
  ffprobe actually says into one line ("Invalid data found when processing
  input"), falling back to the exit code only when it stays silent.
- **There was nowhere to see it.** A warning-coloured count in the header opens
  the list: file, full path, reason, and a copy button, because the reasons come
  from ffprobe and are worth pasting into a bug report.

Also fixed in passing: `analyzed += fresh.len()` counted the same records once
per chunk, since `fresh` is only emptied on a flush. Harmless — the value is
only read as `analyzed > 0` — but wrong.

**What is left** — the list lives in the view's state, so it is gone after a
restart and a skip that happens while the user is elsewhere is only visible
until then. That is C3's job, and this is its first real source.

*Size: S*

### C5 · Pause and resume long scans — **done**

**What shipped** — a `paused` flag on `ScanState` and one gate, `await_resume`,
called immediately before the next unit of work is taken in all three phases:
the analysis chunk loop, the BPM pass and the fingerprinting inside the
duplicate search. Whatever is already in flight always finishes and is
persisted, so a pause never costs a file its analysis. Cancelling while paused
ends the run rather than leaving it parked — both `cancel_scan` and
`cancel_dedupe` clear the flag, and the gate checks cancellation in the same
loop.

There is no separate pause button: the scan button *is* the control. While a run
is on it shows the run — "BPM 5144/10000" — and on hover or keyboard focus it
shows what a click would do, "Pause scan"; while the run is held it reads
"Paused · BPM 5144/10000" and offers "Resume scan". Both faces sit in one grid
cell, so the button is as wide as the wider of the two and does not resize under
the pointer. The pause travels with the progress event, so button and label
survive a reattach after a reload. Where there is nothing to count yet, "Scan
paused" stands alone rather than reading as two states at once.

Verified over libraries of 10,000 and 6,000 generated files: the counter held at
5144/10000 across ten seconds and continued from there on resume, and the button
swapped between status and action on hover in both directions.

**What is left**:

- **C5a** — the *first* population of a library is not pausable. It does not go
  through the scan job at all: the incremental sync diffs the folder and hands
  every new file to `analyze_files`, one blocking command with no progress
  events and no gate. On 10,000 files that is six and a half minutes of a
  spinner that cannot be stopped — and it is exactly the run a user would most
  want to hold. Routing it through the scan job would fix the pause and the
  missing progress at once.

*Size: S*

### C6 · Sidecar self-test at startup — **done**

**What shipped** — `audio::sidecar::self_test` runs both binaries with
`-version` once at startup, spawned off the launch path so it cannot delay the
window. `-version` is enough: what goes wrong in the field is the binary not
starting at all — a `dyld: Library not loaded` for a dependency that only
existed on the build machine, a wrong architecture, a missing quarantine
exemption — and that fails before any argument matters.

A failure is said twice, because it means nothing the app does will work: as an
`error` in the event log (C3), and as a banner in the library view that names
the loader's own message and suggests re-installing. The verdict is stored in a
`SidecarState` the frontend reads through `sidecar_error`, rather than the UI
running a test of its own.

Verified by standing a failing binary in for `ffprobe` and starting the built
app directly (a `tauri dev` run rebuilds and copies the real sidecar back over
it): banner, log entry and the skipped-file report all named the dyld error.

That test also turned up a mismatch worth fixing: `probe_error` took the *last*
line of stderr, which for a loader failure is "Referenced from: ffprobe" rather
than the diagnosis. It prefers the `dyld` line now, and keeps last-line
behaviour for ffprobe's own errors, which are the other way round.

**What is left** — the check does not re-run. A sidecar that breaks while the
app is running (an update replacing the bundle underneath it) is still only
visible through failing operations.

*Size: S*

### C7 · Invalidate the cover thumbnail cache after a write

**What** — give `CoverThumb`'s cache something that invalidates it. It is a
module-wide `Map<path, dataURL>` keyed by the path alone
(`src/components/CoverThumb.tsx`), and nothing ever evicts an entry.

**Why** — a tag write that changes or removes the artwork leaves the old
thumbnail on screen until the app restarts. The row itself is fine — a written
file comes back re-analyzed, so `has_cover` is current — but the image is
rendered from the cache regardless of it, so a correct write looks like one that
did nothing. Found while clicking through the "no cover" fix. It is also the one
cache in the app that does not say what invalidates it, which `CLAUDE.md`
requires of every cache. The write result already names the paths it touched, so
dropping exactly those entries is enough.

*Size: S*

### C8 · Undo should restore the original cover bytes

**What** — let an undo put back the artwork it captured, byte for byte.
Today the snapshot stores the previous cover as `CoverInput::Data`, and the
restore hands it to `artwork::process_cover` like any other new cover
(`src-tauri/src/metadata/write.rs`), which decodes it and re-encodes a JPEG at
quality 90.

**Why** — the dimensions and the file size come back the same, so nothing looks
wrong, but the bytes differ and every undo round costs one more JPEG generation.
Undo is the one operation whose whole promise is that the file ends up where it
started; everything else about it already keeps that promise. Bytes that came
out of a file this app processed are already CDJ-shaped, so the fix is a path
that embeds them verbatim rather than a second trip through the encoder.

*Size: S*

---

## D — Performance

### D1 · Core- and memory-aware worker budget

**What** — bound analysis concurrency explicitly by host parallelism *and*
available RAM, keeping roughly two cores free for the OS and the UI thread, with
an env-var override for debugging.

**Why** — that is exactly what the reference project does, and their stated
reason is sound: a high-core, low-RAM machine otherwise either pegs every core
and makes the app unresponsive, or runs out of memory mid-batch.

*Size: S*

### D2 · Cursor pagination for very large libraries

**What** — page track rows from SQLite with a signed cursor instead of handing
the whole table to the frontend.

**Why** — the list is virtualized, so rendering is fine, but we still load every
row. The reference project pages, and signs the cursor so it cannot be replayed
against a different query.

*Size: M · only worth doing against a real complaint, not preemptively*

### D3 · Progressive per-field row updates during the scan

**What** — patch individual fields into a row as each piece of analysis
finishes, rather than refreshing on batch completion.

**Why** — the library feels responsive much earlier. Their ordering detail is
worth copying too: fill the fields in the same left-to-right order the columns
appear in, so progress reads naturally.

*Size: S*

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

### E2 · Harden Bandcamp download handling

**What** — validate content type and size before writing, extract archives with
zip-slip protection, and keep treating everything that comes down the wire as
untrusted until it has been checked.

**Why** — it is the one path where the app writes attacker-influenceable file
names and paths into the user's library.

*Size: S*

### E3 · Narrow the `assetProtocol` scope

**What** — replace `$HOME/**` and `/Volumes/**` with the library directory and
whatever staging path drag-in needs.

**Why** — the current scope is far wider than the feature requires, and
`CLAUDE.md` asks for these scopes to be as narrow as the feature allows.
Any change here needs verifying in a real build, not just `tauri dev`.

*Size: S*

### E4 · Dependency auditing in CI

**What** — `cargo audit` (or `cargo deny`) and `npm audit` as a scheduled
workflow, plus keeping `THIRD_PARTY_LICENSES.md` current per release.

**Why** — we ship a bundle containing FFmpeg under a different licence than our
own code; both the security and the licence side deserve a recurring check
rather than a manual one.

*Size: S*

### E5 · Move the Discogs secret into the Keychain

**What** — store the Discogs API credentials in the macOS Keychain instead of
`rekord-lib.json`.

**Why** — it is the only genuine secret the app holds, and it currently sits in
plaintext in the app data directory.

*Size: S*

---

## F — Documentation and process

The area where the reference project is clearly ahead, and where the return per
hour is the best of anything on this list. They maintain fourteen documents
under `docs/`; we have a README, a styleguide and `CLAUDE.md`.

### F1 · Functional docs per feature area

**What** — one document per area under `docs/`, each following the same shape:
*How it works* → *Deep technical details* → *Implementation anchors* (concrete
file and symbol references) → *Verification links* (which tests prove it).

**Why** — the *Implementation anchors* and *Verification links* sections are the
part worth copying: they keep the document honest, because a stale anchor is
immediately visible. Start with the three behaviours least obvious from reading
the code: scanning and cache invalidation, duplicate detection, and the
conversion/compat rules.

*Size: M*

### F2 · `docs/COMPARISON.md`

**What** — how rekord-lib differs from Rekordbox, and from the adjacent tools,
including an honest statement of what we do *not* do (we do not build the USB
drive).

**Why** — it is the document that tells a stranger in thirty seconds whether
this app solves their problem. Theirs is a good template.

*Size: S*

### F3 · `CONTRIBUTING.md`

**What** — contribution guidelines, including the inbound = outbound MIT
statement and the hard rules that already exist in `CLAUDE.md` (never copy
Homebrew binaries into the bundle; every change ships with tests).

*Size: S*

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

### F5 · Severity marking in the changelog

**What** — mark a release as critical in `CHANGELOG.md` (they use a
`**Severity:** critical` line under the version heading), and have the updater
UI render a prominent banner for it instead of the usual quiet indicator.

**Why** — the updater plumbing already exists in `src/lib/updater.ts`; this is
the missing piece that makes a security or data-loss fix actually reach people
promptly.

*Size: S*

### F6 · `docs/COMMANDS.md`

**What** — a reference for the Tauri command surface in
`src-tauri/src/commands.rs`: name, arguments, what it returns, what it emits.

*Size: S*

### F7 · `TODO.md` with recorded deferred decisions

**What** — a place for ideas that were considered and consciously *not* done,
with the reasoning and the condition that would make them worth revisiting.

**Why** — the reference project's `TODO.md` has exactly one entry, and most of
it explains why the work was deferred and what evidence would change that. That
is far more useful than a list of undone tasks, and it stops the same idea being
re-litigated every few months.

*Size: S*

---

## G — Reach and test depth

### G1 · End-to-end tests

**What** — drive the real app through the main flows (first run, scan, convert,
resolve duplicates, edit metadata) with WebdriverIO plus `tauri-driver`.

**Why** — we have 119 Rust tests and 32 frontend test files, all at unit level.
The reference project runs Playwright specs against a mock API client for
scan/analysis batching, exports and empty states, and reports e2e coverage
separately. Unit tests do not catch a broken wiring between a command and a
view.

*Size: L*

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
2. ANLZ generation (needs B3 and B6);
3. PDB writing behind an explicit experimental flag;
4. timestamped pre-write backups from the very first write (C1), never bolted on
   afterwards.

And build on the existing open format work — [rekordcrate][rc] and Deep
Symmetry's [crate-digger analysis][cd] — rather than reverse-engineering from
zero.

*Size: XL · blocked on CDJ/XDJ hardware · depends on A1, B3, B6, C1*

[rc]: https://github.com/Holzhaus/rekordcrate
[cd]: https://djl-analysis.deepsymmetry.org/

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
  the reason new UI does not drift from the styleguide — a deliberate
  difference, not a gap.
