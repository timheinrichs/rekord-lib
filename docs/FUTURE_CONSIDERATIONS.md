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
| [I](#i--interface-and-playback) | Interface and playback — what the app looks like and how it plays |

---

## A — Interoperability

The library is prepared inside rekord-lib and then has to leave it. Today that
handoff is "the files are correct now, go import them in Rekordbox", which
throws away everything the app knows beyond the tags.

### A1 · Playlists in the app — **done**

**What shipped** — `playlists` and `playlist_items` (schema 9) with the position
spelled out, the ordering rules pure in `src/lib/playlists.ts`, and a fifth
grouping in the library table. Full description in
[`PLAYLISTS.md`](PLAYLISTS.md).

**A grouping, not a sidebar.** The entry did not say where playlists would live;
a sidebar was the obvious answer and the wrong one. As a fifth mode next to
Flat / Album / Label / Folder, the virtualised table, every column, the
selection and the group heads carry over unchanged and the window keeps its
shape. It is the one grouping whose rows are *not* sorted, because there the
order is the content — which is also why the position gets the chevron's column,
a cell that until now existed only to keep the others in line.

**The whole list, never a diff.** `playlist_set` replaces a playlist's contents
with exactly the array it is handed. The order is the payload, a reorder rewrites
most positions anyway, and a playlist is tens of rows — so the complexity a diff
would buy is complexity for nothing, and exactly one place has to be right about
what the new order is.

**Two ways to reorder, one rule.** Drag, and ↑/↓ on the row — because a drag is
unusable the moment the target is off screen, which on a real set is most of the
time. `stepPlaylistItem` expresses a step as the drag's own move, and a test
asserts they agree; the trap is direction, since a track is lifted out before it
is put back and moving down has to aim one row further than it looks.

*Size: M · done*

### A2 · Rekordbox XML export — **done**

**What shipped** — `export::rekordbox` writes a `DJ_PLAYLISTS` document: the
whole library as a `COLLECTION`, every playlist as a node, and per track the
tags, `AverageBpm`, `Tonality`, `TotalTime`, `SampleRate`, `DateAdded`, a
percent-encoded `Location` and one `<TEMPO>` marker. Behind a save dialog, which
is why `dialog:allow-save` joined the capability.

**It needed a third piece the entry did not know about.** The beat grid was
computed on every analysis and *dropped* — no table, no reader, nothing drawn,
despite `COMPARISON.md` claiming otherwise for two releases. A `<TEMPO>` marker
needs exactly what the detector produces, so `tracks.beat_offset_secs` and
`beat_confidence` came first, with the phase shifted onto the track's own clock:
the detector counts from the start of its 120 s excerpt, so the raw number would
have put every beat half a minute early in somebody's player.

**Cue points are not written**, though the entry listed them. The app has no
concept of one, and inventing empty marks would put them in a player where
nobody set them. Same for `Size`, which a track row does not carry.

**The format was not guessed, and the test proves it in the other side's
language.** `scripts/rekordbox-reference.py` has read real Rekordbox exports
since the tempo benchmark existed; the writer's output goes back through that
reader and has to come out as the rows it went in as. It is the only check here
that did not come out of the same head as the writer — and a filename with
non-ASCII in it is the case that fails first when the `Location` encoding is
wrong.

**What is still only provable by hand:** that Rekordbox itself likes the file.
The round trip says the document parses and carries the values, not that the
program on the other side accepts it. Import it once before trusting a change.

*Size: M · done*

### A3 · Read an existing `rekordbox.xml`

**Now unblocked.** A2 shipped, and with it a writer whose field handling A3 can
read back — plus `scripts/rekordbox-reference.py`, which already parses the half
of the format that matters for a library import.


**What** — the other direction: adopt an existing Rekordbox collection instead
of asking the user to start from an empty library.

**Why** — lowers the barrier for anyone who already has a curated collection,
and it hands us a reference set of BPM and key values to measure our own
detection against (see B7).

*Size: M · depends on A2*

### A4 · Cue points

**What** — a cue point concept: a position on a track, named, with the app able
to set and move it, and `export::rekordbox` writing it out as a
`<POSITION_MARK>` per mark.

**Why** — it is the one thing A2 deliberately left out, and A2 says why in its
own entry: *"Cue points are not written, though the entry listed them. The app
has no concept of one, and inventing empty marks would put them in a player
where nobody set them."* The export half is therefore already built and already
proven against real Rekordbox files; what is missing is upstream of it.

Two things this needs beyond storage and UI. The round trip that keeps the
writer honest reads `<TEMPO>` and nothing else —
`scripts/rekordbox-reference.py` has no cue element in it — so closing the loop
means teaching the reader about marks as well. That check is the only one in the
export that did not come out of the same head as the writer, and a cue feature
that skips it is a cue feature nobody can verify.

And be clear about where a mark actually arrives. Through A2 it reaches
Rekordbox, which is the realistic path; onto a CDJ without Rekordbox in between
it would need ANLZ files, which is H1. Worth saying in the UI rather than
letting someone assume the drive will carry them.

*Size: L · completes A2 · full player support depends on H1*

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

### B1 · Key detection — **done**

**What** — musical key, written as Camelot or Open Key.

**Why** — the one piece of technical metadata DJs sort by that we do not
produce. Feeds the metadata editor and the library table.

**What shipped** — `audio/key.rs`: the spectrum folded into twelve pitch classes
and correlated against each key's expected pitch distribution, with the Shaath
profiles. It reaches **35.6 % exact** against the 2180-track Rekordbox reference,
against the crate's 29.6 %, and comes with a confidence that rises from 32 % to
71 % agreement across its range. `MusicalKey` — the pitch-class-plus-mode type
with the Camelot mapping — moved out of the benchmark harness into the shipped
code, so the tested implementation and the used one are the same one.

**In the database, never in the file.** This is the decision that matters more
than the accuracy. A wrong `TKEY` is read by every other program and outlives the
guess that produced it, while a database value is replaced the moment a better
detector exists — the reasoning that already keeps `compat` recomputed rather
than stored. Shown in the library table and the metadata editor, read-only, with
the percentage next to it.

**As the name alone** — `Am`, `A`, `F#m`, the spelling a musician uses and the
one Rekordbox writes. It used to read `Am · 8A`: the Camelot position is the more
useful number when picking the next record, but in a one-line cell it competed
with the name instead of helping it, and `8A` means nothing to somebody who has
not learned the wheel. It moved into the cell's tooltip, spelled out — `A minor ·
8A` — where it costs no width and explains itself. The filter menu still orders
by Camelot, which is where that number actually does its work.

**What that leaned on** — the reference project has had key detection longer than
we have, which reads like an argument for shipping it into tags. Its own design
says otherwise: analysis results go into its database and from there into the
Rekordbox export on the USB drive, and although it depends on the same tag
library we do, it never calls the write path. A third of a percent of accuracy is
acceptable in a layer you can throw away.

**What the numbers cannot settle** — the reference cannot be scored, being the
reference. But our detector agrees with Rekordbox (36.0 %) slightly *more* than
with the crate (34.1 %), so Rekordbox is not the outlier and the gap is the
difficulty of the task. See [`DSP_BENCHMARK.md`](DSP_BENCHMARK.md).

It does *not* feed `TrackMetadata::is_complete`, despite what this item
originally said: BPM is deliberately optional there, and a required key would
mark practically every library incomplete overnight. The filter menu lists the keys
present in the library, in Camelot order — 1A, 1B, 2A … — so neighbours on the
wheel are neighbours in the menu and two mixable keys are two adjacent entries.
Alphabetical would put A#m beside Am and eleven steps from what it mixes with.

*Size: L · done*

### B2 · Fractional BPM and an exposed confidence value — **done**

**What shipped** — `detect_bpm` returns a `Tempo { bpm: f32, confidence: f32 }`
instead of an `Option<u32>`. The tempo keeps its decimals all the way into the
tag (`format_bpm` writes two, the way Rekordbox does) and into a `REAL` column
(schema v5). The confidence comes from the two quantities the gates already
measured — how strongly the autocorrelation peaked, and how far that peak stood
above the mean of the searched range — combined as a geometric mean so that
strong-but-unremarkable does not pass for confident.

Below `MIN_WRITE_CONFIDENCE` a tempo is stored but **not** written into the file;
the library table marks it, and the metadata editor shows the percentage next to
the value along with "not written". So the number on screen and the number in
the file can never silently disagree.

The **display** rounds to whole beats, which is what DJ software shows and what
the maintainer asked for. That is only safe because the editor's tempo field
keeps its stored value unless it is actually edited — otherwise a whole-number
field would write 128 back over a stored 127.61 on any save, including one that
changed nothing but the genre.

**The threshold is measured, not chosen.** Over the 2143 reference tracks that
yield a tempo, 0.30 prevents 20 wrong tags at the cost of 4 correct ones; 0.40
costs 14 for three more; at 0.60 the trade is one-for-one, and at 0.90 it
destroys 375 correct values to prevent 201 wrong ones. Worth stating plainly:
the gate catches 20 of 327 wrong values, about 6 %. The confidence separates
hopeless from plausible, not right from wrong — the hard gate in `audio/bpm.rs`
and undo are what actually protect the files.

**Three bugs the tests found**, none of them in the DSP:

- Appending `bpm_confidence` to `TRACK_COLUMNS` shifted the columns
  `load_track_cache` reads by index, so it took a confidence for an mtime.
  `TRACK_COLUMN_COUNT` plus a test that compares it against the list makes the
  next added column fail loudly instead of silently.
- The v5 migration has to rebuild `tracks` (SQLite cannot retype a column), and
  `fingerprints` cascades on its deletion — with foreign keys left enabled the
  whole fingerprint cache would have gone with it, silently.
- The `f32` detector widened to `f64` produced values like `127.5999984741211`,
  which reached the database and the editor while the file said `127.60`.
  Rounding now happens once, before anything is stored.

**Verified end to end** in a `-devtest` app instance over generated click tracks:
a 127.6 BPM tone comes back as `127.61` in both the tag and the database, and
silence gets no tempo at all.

*Size: S — the DSP change was small; the persistence and display around it were not*

### B3 · Beat grid — **done, without the downbeat**

**Since A2 it is also stored and exported.** For two releases the grid was
computed on every analysis and thrown away — no table, no reader, nothing drawn,
while this entry and `COMPARISON.md` both read as though it were in use. It now
lives in `tracks.beat_offset_secs`/`beat_confidence` and becomes the `<TEMPO>`
marker in the Rekordbox export. Drawing it under the waveform, which is what
this entry was originally about, is still not done.

**What shipped** — `audio/beats.rs` finds the beat *phase* for a known tempo by
comb filtering the onset curve. Measured against Rekordbox' own grid markers, the
median error is **0.035 of a beat** (16 ms at 128 BPM) on the 1398 tracks where
the comparison is fair — enough to draw beats over a waveform, where the error is
smaller than one bin. See [`DSP_BENCHMARK.md`](DSP_BENCHMARK.md).

**Two numbers, not a list.** The plan called for a `beat_grids` table holding
beat positions as a BLOB. Our detector produces one tempo per track by
construction, so a grid *is* a period and a phase; a few hundred stored positions
would be the same information with room to disagree with itself. A variable-tempo
grid would need more, and that is a different feature.

**The first downbeat is not done.** Finding which of four beats starts the bar is
a harder problem than the phase, and this benchmark cannot even score it fairly:
Rekordbox' first marker is only on a downbeat for 1231 of 2197 tracks. Shipping a
downbeat guess into a grid that later writes ANLZ files would be the wrong order
of operations — H1 is blocked on hardware anyway.

*Size: M · done, minus the downbeat*

### B4 · Analyse more than one window — **measured and rejected**

**What was tried** — three 120 s excerpts spread over the track instead of the
single one at 0:30, reconciled by clustering: the largest group of agreeing
windows wins, and its share scales the confidence.

**Why it is not shipping** — it changed the outcome by **one track out of 2175**
at 2.9× the decode cost, and the tier it existed for did not move at all: the 568
tracks whose Rekordbox grid wanders scored 73.1 % within ±2 BPM either way. The
premise does not hold on a real collection — where a track has one tempo, one
window finds it, and where it has none, no single number is right. Numbers in
[`DSP_BENCHMARK.md`](DSP_BENCHMARK.md).

**Worth keeping in mind** — the one real effect was on the *confidence*, not the
tempo: agreement between windows separates correct from wrong answers noticeably
better than a single peak does (mean gap 0.16 → 0.25). Too small to justify three
decodes per track, but the right place to look if the write gate from B2 ever
needs to be sharper. The mechanism was removed rather than left in unused.

*Size: S · done, negative*

### B5 · Configurable BPM range — **done**

**What** — expose min/max BPM as a setting. Ours is hardcoded 60–200; theirs
defaults to 70–180 and comes from settings.

**What shipped** — a *Tempo range* dropdown under Settings → Analysis, six
presets: the historical `60–200 (wide)` as the default plus five that span
exactly one octave (`max = 2 × min`), from `60–120` to `100–200`. Stored as the
two numbers rather than a preset name, threaded through `analyze_files` and
`start_scan` into `TempoConfig`, and sanitised there so a reversed or absurd
range falls back to the default instead of turning every file into "no tempo".
Presets rather than free number fields: within one octave every tempo has a
single representative, which is the whole reason a narrower range could help.

**Why the default did not change** — because it was measured, and narrowing does
not help. 70–180 is indistinguishable from the wide range (+8 tracks out of 2175,
p = 0.45), and 90–180 is significantly *worse* (−26, p = 0.03) while leaving 22
tracks with no tempo at all. The presets stay as an option for a library that
really does sit in one genre; this collection, spread over 70–185 BPM, cannot
test that case. See [`DSP_BENCHMARK.md`](DSP_BENCHMARK.md).

**What that also refuted** — B7's own write-up called the 101 octave errors
answering outside the reference's range "the concrete argument for B5". Running
our detector at 70–180 removes that class by construction and gains nothing, so
those are genuine detector errors, not artefacts of the mismatch.

Nothing new was needed to make a range change reach a tagged library: the
existing "Re-detect BPM" action in Settings already does exactly that, which the
dropdown's help text points at.

*Size: S · done*

### B6 · Waveform preview in the player bar — **done**

**What shipped** — the player bar's progress line is a waveform. `audio/waveform.rs`
decodes the whole file at 11 kHz and reduces it to 2400 bins of **peak and RMS**,
normalised so the loudest bin is 1.0; `components/Waveform.tsx` draws it on a
canvas, one column per device pixel, with the played part in accent and the rest
in the border/subtle tokens. Click-to-seek and the slider semantics of the old
bar are kept — a canvas that dropped them would have quietly removed a control.

Two values per bin rather than one because a peak-only waveform is a solid
block: the peak outlines the transients, the RMS shows where the energy sits, and
the RMS being the brighter of the two is what makes an intro distinguishable from
a drop at a glance. Normalised rather than absolute because the bar has a fixed
height — a quiet master would otherwise draw as a flat line and look broken.

**Cached on disk after all** — the reasoning that follows held only while the
player bar was the sole consumer, and a waveform *column* in a 2200-row list
changes the premise: computing one per visible row means a full decode while
scrolling, and twenty rows at 300 ms each is a list that fills in behind you.

~~Deliberately not cached on disk. A stored copy would be ~19 KB per track —
40 MB for this collection — plus an invalidation contract to keep honest, in
exchange for a sub-second saving on a replay.~~ Both halves of that turned out to
be beatable. The values quantise to a byte each — they are normalised to 0..1 and
rounded to pixels when drawn — which is 4.8 KB a track and ~11 MB rather than 42;
and the analysis pass already decodes the file, so the waveform costs the
difference between decoding 120 s and the whole track rather than a decode of its
own. Schema 7, table `waveforms`, invalidated like a fingerprint (mtime, size,
`waveform::ALGO_VERSION`) with tests for each.

Its own table rather than columns on `tracks`, because every query that lists the
library would otherwise carry 11 MB of blobs it does not need; the list asks for
the paths on screen. The frontend's in-memory cache
(`lib/waveformCache.ts`, promise-keyed so skipping between two tracks cannot
start the same work twice) stays useful for the player bar.

The row waveforms in the table batch their requests: the rows that ask are the
rows on screen, so one call per scroll position rather than twenty
(`lib/waveformBatch.ts`). A path with nothing stored is remembered as **absent**,
which is what stops a track the scan has not reached from being re-requested on
every scroll past it.

**That memory needs two things to be dropped, not one.** Clearing the cache when
a scan finishes is not enough: a row asks once, on mount, so a row that was
visible while the scan ran keeps the "there is none" it was given and stays blank
until it happens to remount. The symptom was oddly specific — waveforms appeared
for tracks inside an album and nowhere else, because those rows mount when the
group is expanded, which is after the scan. `forget()` therefore clears the cache
*and* re-asks for every path still being listened to. Also after a cancelled run:
the analysis stores per track, so a scan stopped halfway still left waveforms
behind. The unit tests were green throughout — they asserted that a *new* request
re-fetches, which is not the thing that was broken; the test that catches it
drives `LibraryView` and its scan-done handler.

The remaining case for a separate stored artifact is the ANLZ waveform (H1),
which is denser and has its own format.

**Still needed for H1** — the analysis-file waveform is denser and has its own
format; this covers the UI half of that split, not the player-file half.

*Size: M · done*

### B7 · Benchmark `stratum-dsp` against our detector — **done**

**What shipped** — the reference set turned out to be the larger half of the
work. The 21 tracks this item assumed were a lost local measurement, so
`scripts/rekordbox-reference.py` now reduces a Rekordbox XML export to
`src-tauri/tests/data/bpm_reference.csv`: **2180 tracks** with tempo, grid drift
and key, filenames hashed so the file says nothing about the collection it came
from. `src-tauri/tests/dsp_bench.rs` scores both engines against it, with the
scoring logic covered by ordinary unit tests that need no audio.

**The result** — we keep ours. On the identical 120 s window our detector is
right within ±2 BPM on 87.1 % of steady-grid tracks against the crate's 83.1 %,
and costs 30 ms of analysis against 2087 ms. Given the whole track it is designed
for, the crate gets *worse* (81.8 %) and 3.6× slower. Key detection reaches
29.6 % exact against Rekordbox where its README claims 72.1 %, so **B1 loses its
cheap path**. Full numbers, limits and reproduction:
[`DSP_BENCHMARK.md`](DSP_BENCHMARK.md).

**What it changed elsewhere** — B1 is now "write it or defer it", not "buy it".
B4 is back on the table, since it was only redundant if a full-track engine had
won. B5 has a measured baseline: 101 octave errors answer outside the reference's
own 70–180 BPM range and cannot be judged against it at all. `stratum-dsp` stays
a `[dev-dependency]` so the comparison can be re-run against a future version.

**What the benchmark cannot say** — our tempo prior was fitted against 21 tracks
of this same library, so part of the margin is home advantage; and grid accuracy
was never measured, which is what B3 would need.

---

## C — Robustness and data safety

**Closed.** Every entry in this tier has shipped. What was split off when one of
them landed lives in [TODO.md](../TODO.md) as `C1a`, `C1b` and `C2a`, each with
the condition that would revive it.

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

**C5a is closed too.** The *first* population of a library used to bypass the
scan job entirely: the incremental sync diffed the folder and handed every new
file to `analyze_files`, one blocking command with no progress events and no
gate — six and a half minutes on 10,000 files, and the run a user would most
want to hold. The sync now does the diff and nothing else, and the new paths go
to the job, which was already able to take a subset. One decode per file either
way, because the tempo comes along in the same run instead of a second pass over
the same files.

The splash also stays up through it rather than dropping to an empty table with
one unlabelled spinner in the header, which is what that arrangement actually
looked like — it says *Loading library…* while the folder is being diffed and
then counts with the scan.

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

### C7 · Invalidate the cover thumbnail cache after a write — **done**

**What shipped** — the cache moved out of `CoverThumb` into
`src/lib/coverCache.ts`, which states the rule it was missing: *a thumbnail is
valid until the file behind it is written.* `forgetCoverThumbs(paths)` is the
counterpart, in the shape `RowWaveform`'s `forgetRowWaveforms` already had.

**Dropping the entry was not enough**, which the entry did not say. A row that is
already on screen asked once and will not ask again until it remounts, so
clearing its entry leaves exactly the stale image the fix is about. `forget`
therefore re-asks for every path a mounted row is still listening to, and only
drops the rest.

**Four things invalidate, not one.** The entry named the write result; a
conversion re-embeds the cover too (and an in-place one keeps the path, which is
precisely when a cached thumbnail outlives its file), and a file that changed on
disk comes back through the scan's `scan://tracks`. An undo needs no separate
hook — it returns through the same `applyWriteResults` as a write.

**A read already in flight is discarded**, not just unsubscribed: it describes
the file as it was *before* the write, and letting it land would restore the old
thumbnail by a longer route. Each path carries an epoch that `forget` bumps.

*Size: S*

### C8 · Undo should restore the original cover bytes — **done**

**What shipped** — the undo snapshot marks its items `cover_verbatim`, and
`finalize` then embeds the captured bytes exactly as they are, with the mime type
read off the bytes instead of assumed to be JPEG. Restoring a 3000 px PNG
verbatim is the correct outcome here: undo's contract is the state before the
write, not a CDJ-shaped approximation of it. Bytes it cannot identify as an image
fall back to the encoder rather than being embedded on a guess.

**A field rather than a `CoverInput` variant.** Serde ignores an unknown field,
so an older build reading a newer undo entry re-encodes the way it always did; a
new variant would fail to deserialize there instead. This repo keeps downgrades
working on purpose — the legacy `library` key is kept for the same reason.

**The same trip through the encoder was happening on every ordinary write**,
which the entry did not mention: `Keep` resolves to the artwork already in the
file, so each edit re-encoded it — the same picture, one generation worse, for
nothing. `artwork::already_cdj_shaped` answers whether bytes are already what
`process_cover` would produce, reading the size from the JPEG frame header rather
than decoding, and the encode is skipped when they are. Narrow on purpose: a PNG
is still converted, because that is part of what CDJ-shaped means here.

**It also closed a test gap.** `artwork.rs` had no tests at all; it now has the
round trip that matters — what the encoder produces is recognised as not needing
the encoder again — and `write.rs` proves the undo claim against a real file
rather than a mock: write a cover, replace it, restore, compare the bytes.

*Size: S*

### C9 · "No tempo" is an answer worth storing — **done**

**Found in use, not in review.** A real 2217-track library re-analysed the same
38 files at every start. They turned out to be exactly the material with no
periodic pulse to find — interludes, an intro, a vinyl snippet, a station air
check, a drone — where `detect_bpm_with` correctly returns `None`. Nothing is
written for them, so they were still missing a tempo the next time the backlog
looked, and it looked on every launch: 38 files × a 120 s decode, forever.

**The cause was a missing distinction, not a bug in the detector.** `bpm IS
NULL` covers both "not analysed yet" and "analysed, and there is nothing there",
and the backlog could not tell them apart — the same distinction the waveform
batcher and the cover cache make explicitly (`undefined` = not asked, `null` =
asked, none), missing in the one cache where the cost is a decode.

**What shipped** — `tracks.bpm_absent_at` (schema 8) records the app version
whose detector came back empty, `TrackAnalysis::bpm_absent` derives from it on
read, and `pathsMissingBpm` skips those files. Version-stamped rather than a
flag, so it expires on its own: every release gets one more attempt at each of
them, which is what a changed detector deserves, and neither a migration nor a
cleanup step is needed. A tempo found later takes the mark off again, so a row
never claims both.

**What the review caught, and it was worse than the bug.** The first version
marked a file whenever the analysis came back without a tempo — including when
the analysis had *failed*. A library on an external drive that unmounts
mid-scan would have had dozens of perfectly rhythmic tracks silenced until the
next release. The pass now keeps the analysis `Result` rather than flattening a
failure into an empty one, and the mark is read off the row after the patch, so
a forced re-detect over a file that already carries a tempo tag cannot leave a
row claiming both.

*Size: S*

---

## D — Performance

### D1 · Core- and memory-aware worker budget — **done**

**What shipped** — `audio::workers::budget` takes the smaller of two budgets —
cores minus two, and how many workers of a given size fit in the free memory
(`sysinfo::System::available_memory`) — and clamps it into `1..=cap`. It is asked
once at the start of each pass rather than once at startup, because the free
memory of a machine changes over a session. `REKORD_JOBS` overrides both terms
for debugging, clamped to 64 so a typo cannot fork-bomb the machine.

**`cap` is the value the pass was measured at, so the budget can only lower the
width, never raise it.** Both passes keep their 8. On an 8-core Mac that now
means 6, and a 16-core machine still gets 8 — going above a measured number on
the strength of a heuristic would be a guess in better clothing.

Only the passes that actually decode are bounded, and only one of them is really
memory-bound:

| Pass | Per worker | What binds it |
| --- | --- | --- |
| BPM/key/waveform | 96 MB | Decodes the **whole** file (mono `i16` @ 11025 Hz, held in the byte buffer and the sample vector at once — ~44 kB per second of audio, so ~26 MB for 10 minutes and ~160 MB for a one-hour set). Memory binds first on a high-core, low-RAM machine. |
| Fingerprint | 8 MB | A fixed 120 s window, ~5 MB. Memory never binds; this is core-awareness only. |

**`PROBE_CONCURRENCY` deliberately stays outside the budget.** ffprobe reads
headers, not audio, so it holds nothing worth budgeting, and the measurement
already recorded next to the constant says the pass is bound by process startup
rather than by cores. Lowering it with the others would cost scan time to solve a
problem it does not have.

Verified in a running app on a 12-core machine with 7.8 GB free: width 8 (the cap
holds — cores alone would allow 10, memory 81), and 3 with `REKORD_JOBS=3`. The
pass prints the number it chose, alongside the cores and the free memory it chose
it from, because "the scan is slow" is a real report and this is the first thing
worth knowing about it.

**Counting ffmpeg processes does not work as a check, which cost an hour.** The
generated dev library decodes at roughly 1900× real time, so each child lives a
handful of milliseconds and a 200 ms sampling loop reports zero concurrency for a
pass that is fully busy. Measure this from inside the pass, or against real
tracks — not with `pgrep`.

*Size: S*

### D2 · Cursor pagination for very large libraries

**What** — page track rows from SQLite with a signed cursor instead of handing
the whole table to the frontend.

**Why** — the list is virtualized, so rendering is fine, but we still load every
row. The reference project pages, and signs the cursor so it cannot be replayed
against a different query.

*Size: M · only worth doing against a real complaint, not preemptively*

### D3 · Progressive per-field row updates during the scan — **done, per file**

**What shipped** — a `scan://patch` event per finished file, carrying only what
that analysis produced (`TrackPatch`), instead of a batch of whole tracks at the
end of every chunk of eight. `applyPatch` writes the named fields into the row
and leaves the rest alone; a `null` field means *unchanged*, not "not detected",
because the pass never clears a value it failed to find.

**Per field was not available, and it is worth writing down why.** One decode
answers all three questions (`audio::analysis`), so tempo, key and waveform of a
given track finish in the same instant — there is no order to fill them in, and
the reference project's left-to-right detail has nothing to attach to here. The
granularity that exists is per *file*.

**The win turned out to be elsewhere.** A result that produced only a waveform
changes no column of the row, so it was never part of `changed` and was reported
to nobody: waveforms appeared when the whole run finished and
`forgetRowWaveforms` re-asked. A patch carries a `waveform` flag, and
`refreshRowWaveforms` re-asks for just those paths, so a row on screen draws its
waveform while the scan is still going.

**Two things had to stay batched.** Persistence is still one transaction per
chunk — one per file would trade a visible improvement for an invisible cost. And
the patches are collected in a 250 ms window before they reach the list
(`lib/scanPatchBatch.ts`), because the table has no memoised rows: one
`setTracks` rebuilds every row's markup, re-derives filter, sort and grouping,
and re-measures every row height. Four updates a second read as "filling in" and
cost the same whether the analysis produces two files a second or twenty.

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

### E2 · Harden Bandcamp download handling — **done**

**What shipped** — `bandcamp::download` treats the response as what it is: bytes
from a server we do not control, over a session cookie that can be stale,
written into the user's library.

- **Streamed to disk.** The whole album used to be collected into one `Vec<u8>`
  with no ceiling. It now goes to a `.part` file in the app's **cache folder** —
  not the library, which is watched recursively, and a file growing there for
  minutes would fire a re-walk of the collection every 700 ms while it does. A
  `PartFile` guard removes it on every exit that is not a finished download
  (cancel, cap, dropped connection), and the finished file is renamed into place
  or copied when the library is on a different volume.
- **Ceilings, per download, per entry, per archive and per entry count.**
  Generous enough that a real purchase never meets them, and checked against the
  bytes actually written rather than the length the server announces — a zip
  bomb declares little and writes a lot.
- **Names that are names.** The old code took a ZIP entry's last path component
  and, when there was none (`sub/..`), fell back to the *raw* entry name, which
  is a path. `safe_name` now rejects `.`, `..`, the empty string and leading
  dots, an entry with no usable name is skipped, symlink entries are skipped,
  and every output path is checked to be inside the album folder before it is
  created. `sanitize` alone was not enough for the album title either: a title
  of `..` put the album folder one level above the destination.
- **A web page is not a file.** An expired session answers with a login page,
  which used to be saved as audio. Refused now — but on the bytes as much as on
  the header, and on the probe request only *after* the body fails to parse as
  JSON: that answer has never had a reliable content type, which is why the old
  code sniffed its first byte, and refusing it on the header alone would fail
  every download instead of following the `download_url` inside it.

**What it did not need.** Validating the destination against the library folder
was considered and left out: the destination comes from our own frontend, while
the names and bytes come from the network, and the invariant that matters is
that nothing lands outside the folder the caller named.

*Size: S*

### E3 · Narrow the `assetProtocol` scope — **done**

**What shipped** — the static scope in `tauri.conf.json` is `[]`, and the
library folder is granted at runtime (`src-tauri/src/assets.rs`): at startup
from the saved settings, and by `allow_library_playback` whenever the folder
changes. Nothing else is ever granted.

**The command takes no folder**, which the first attempt got wrong and the
review caught: a command that grants what it is handed makes the empty static
scope worth nothing, because a stray call can name any folder. Worth being
precise about what that buys, though — the window holds `store:default` and
could write `settings.library_dir` itself, so this is a narrowing rather than a
boundary. What is gone is the *unconditional* grant: `$HOME/**` and
`/Volumes/**` were readable before anything asked. A hard boundary would mean
the backend owning the setting. It reads the folder the user saved, so the frontend calls it after the
write rather than instead of it. The path is normalised first — left to the
scope's globbing, `/Users/me/Music/../..` is `/Users` — and has to be at least
two components deep, because every one-component path on macOS is a system
folder rather than somebody's music.

**Proved in a built app, because nothing else can prove it.** `e2e/playback.spec.ts`
loads the same audio file twice through `convertFileSrc` and an `Audio` element —
the player's own path — once from the library folder and once from a copy
outside it. The first plays, the second does not. A flow test has no protocol
handler to answer at all, and `tauri dev` is not what ships, so this claim had
no home until the suite grew one.

**There was no staging path to keep.** The entry assumed drag-in needed one; it
does not. `asset:` has exactly one consumer, `convertFileSrc` in
`lib/player.tsx` — covers come back from commands as data URLs — and everything
playable is under the library folder: the table is loaded per `library_dir`,
drag-in converts *into* the library, and a Bandcamp download is written there.

**Runtime rather than a wider static scope**, because the folder is a user
setting and a config file cannot name it. The grant is not persisted, so a
folder that stops being the library folder stops being readable on the next
start; and it is deliberately not revoked mid-run, which would stop a track that
is playing. A relative path or `/` is refused — the first would resolve against
the process's working directory, the second would hand back everything.

*Size: S*

### E4 · Dependency auditing in CI — **done**

**What shipped** — `.github/workflows/audit.yml`: `npm audit --omit=dev
--audit-level=high` and `rustsec/audit-check` over `src-tauri/Cargo.lock`, every
Monday, on demand, and whenever a lockfile changes in a pull request. Both jobs
run on ubuntu — they read lockfiles, so unlike the backend job in `ci.yml` they
need neither macOS nor the aarch64 sidecars.

**On a schedule, and that is the point.** An advisory is published against code
that has not changed, so a check that only runs on a diff never sees it.

**Where it stands today:** no vulnerabilities. `cargo audit` reports 19
warnings, all of them unmaintained or unsound *Linux* crates (the GTK3 bindings
`gtk-rs` pulls in through Tauri's Linux backend) that a macOS-only build never
compiles. They are warnings rather than failures, so the job is green and stays
honest — silencing them per id would hide the day one of them turns into a
vulnerability.

**The licence side stayed manual on purpose.** `THIRD_PARTY_LICENSES.md` is a
curated overview, not a dependency dump, so it joined the pre-release
documentation pass in `CLAUDE.md` rather than getting a generator.

*Size: S*

### E5 · Move the Discogs secret into the Keychain — **done**

**What shipped** — the consumer key and secret live in the macOS Keychain
(`src-tauri/src/secrets.rs`, `keyring` over Security.framework — a system
library, so the bundle carries nothing new). The service name is derived from
the **bundle identifier**, so the `-devtest` build has its own items and a dev
run can neither read nor overwrite the installed app's credentials, the same
separation the devtest database and settings already have.

**The frontend stopped holding it.** `suggest_metadata` used to take
`discogsKey` and `discogsSecret` on every call; it now reads them itself. What
settings can ask for is whether something is stored (`discogs_credentials`
answers `{ stored, unavailable, key }` — the key is not the secret half and
seeing it is how you tell which app's credentials are in there). The secret
field is write-only and says so.

**Migration, once, in the shape of `shed_legacy_keys`:** a pair still in
`rekord-lib.json` is written to the Keychain and only then deleted from the
store, because losing the only copy to a failed write would be worse than one
more start with it in place. `loadSettings` also drops keys it does not know, so
a value an older version wrote can no longer ride along and be written back by
the next save — that was the path by which the plaintext copy would have
returned after the migration deleted it.

**It fails closed** (decided deliberately): a Keychain that will not answer —
denied, or an ad-hoc-signed update no longer matching the item's ACL — means
empty Discogs suggestions and a line in settings asking for the credentials
again. Nothing falls back to the JSON store; MusicBrainz keeps working, since
`suggest` already treats missing credentials as "no Discogs results".

**What only a real update can answer:** whether the Keychain item survives an
ad-hoc-signed update, whose designated requirement changes with the binary. If
it does not, what the user meets is the fail-closed path — a note and a form,
not a broken app — and it becomes one more argument for **E1**.

*Size: S*

---

## F — Documentation and process

The area where the reference project was clearly ahead, and where the return per
hour was the best of anything on this list. They maintain fourteen documents
under `docs/`; we had a README, a styleguide and `CLAUDE.md`. F1, F2, F3, F6 and
F7 closed that gap — the index is [`docs/README.md`](README.md).

### F1 · Functional docs per feature area — **done**

**What** — one document per area under `docs/`, each following the same shape:
*How it works* → *Deep technical details* → *Implementation anchors* (concrete
file and symbol references) → *Verification links* (which tests prove it).

**What shipped** — four documents rather than the three this item asked for:
[`SCANNING.md`](SCANNING.md), [`DUPLICATES.md`](DUPLICATES.md),
[`CONVERSION.md`](CONVERSION.md) and [`METADATA.md`](METADATA.md) — tags, covers
and undo were added because that is the other place the app writes into the
user's files, and the reasoning around `clear_empty` and the undo snapshot lived
nowhere.

**Anchors name a file and a symbol, never a line number.** A line number is
wrong after the next commit and its wrongness is invisible; a missing symbol is
found by a `grep`. Every anchor and every test named in the four documents was
confirmed against the tree when they were written.

**The *Verification links* sections did the work this item hoped for.** Assembling
them turned up five paths whose tests are thinner than they look —
`convert_tracks`, `write::finalize`, `artwork.rs`, `find_duplicates` and
`DuplicatesModal.tsx` — plus two mirrors that can drift silently
(`norm_text`/`norm_album` in Rust and TypeScript, and the `meta_matches` mirror
of the metadata tier). All of them are in [`TODO.md`](../TODO.md) with the
condition that would close them; none of them were visible from the code.

*Size: M · done*

### F2 · `docs/COMPARISON.md` — **done**

**What shipped** — [`COMPARISON.md`](COMPARISON.md), with *What we do not do*
placed **first**: no USB drive (H1), no playlists yet (A1/A2), no key written
into files, no downbeat, macOS only, nothing uploaded. Then the division of
labour against Rekordbox — we fix the files, it performs with them — against the
tools that write the drive themselves, and against doing it by hand, where the
app's contribution is the verdict rather than the speed.

**Numbers are linked, never re-tabulated.** [`DSP_BENCHMARK.md`](DSP_BENCHMARK.md)
stays the only place a percentage is written down and
[`CDJ_TEST_MATRIX.md`](CDJ_TEST_MATRIX.md) the only place a hardware claim is, so
there is one place to update rather than two that can disagree.

*Size: S · done*

### F3 · `CONTRIBUTING.md` — **done**

**What shipped** — [`CONTRIBUTING.md`](../CONTRIBUTING.md) at the repo root,
because that is the only place GitHub surfaces it in the pull-request UI. It
links the README and `CLAUDE.md` for everything they already say rather than
becoming a third copy of it.

**Two things had no public home before this.** Inbound = outbound MIT, stated
plainly; and how to run the app without damaging a real collection — the dev-run
commands, that a symlink is not isolation, and that a stray `tauri dev` outliving
a config change moves onto the real app data directory. Both incidents are named,
because a rule without its reason does not survive contact with a deadline.

The commit convention was written out too. It existed as one line in `CLAUDE.md`
and as practice in `git log`, which a contributor cannot be expected to infer.

*Size: S · done*

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

### F5 · Severity marking in the changelog — **done**

**What shipped** — a `**Severity:**` line under a version heading in
`CHANGELOG.md`, with **two** levels:

| Level | Means | Gear dot | Settings | Start-up dialog |
| --- | --- | --- | --- | --- |
| `critical` | A security or data-loss fix. Install now. | `danger` | banner, in the shape the library view uses for a broken sidecar | tag + the sentence naming what is at risk |
| `important` | Worth having soon; nothing is at risk while it waits. | `warning` | the pill, in `warning` | tag only |
| *unmarked* | An ordinary release, which is most of them. | `accent` | the pill, in `accent` | no tag |

Two levels rather than three: `critical` is a yes-or-no question about a release,
`important` is the one useful step below it, and a longer scale would demand a
judgement at every release without changing what anyone does about it. The banner
stays with `critical` alone — spending the loud shape on the quieter case is how
a loud shape stops working. `important` gets no explanatory sentence either,
because unlike `critical` it makes no claim about what is at risk, so there is
nothing for a sentence to add that the tag has not said.

**It needed a producer as well as a consumer, which the entry did not say.**
`release.yml` set no `releaseBody` and never read the changelog, so
`latest.json`'s `notes` carried nothing — consistent with the UI, which never
displayed `update.notes` either. So there was no text for a marker to travel in.
`scripts/release-notes.mjs` now cuts the section for the tag out of
`CHANGELOG.md` and the workflow passes it as the release body; tauri-action puts
the same text into `notes`. One source, and the release notes cannot drift from
the changelog.

The extractor **fails the build** when the tag has no section. A release with
empty notes is worse than a failed one, because nobody notices it. It also has to
tolerate what the file really contains — sections in any order, prose directly
under a heading, a `### Note` block, wrapped bullets, and old versions with no
link definition — so it is tested (`scripts/**` is in the Vitest `include` for
this).

**Severity is parsed rather than carried as a field.** tauri-action generates
`latest.json`, so adding a key would mean post-processing the artefact; reading
the marker out of the notes keeps the changelog the only place it is written.
An unknown word is treated as ordinary: a banner nobody meant to trigger is
worse than a quiet one, so `critcal` ships as a normal release rather than as
either level.

The notes are now shown for **every** update, not only critical ones — deciding
whether to restart is easier when you can see what you get.

**And the app asks at start-up**, rather than waiting to be found: `UpdateModal`
shows the notes, a link to the release on GitHub, and Cancel next to Update. It
is dismissible and the dismissal is *not* persisted — the next launch is the next
chance to notice, which is the entire reason for prompting; and forcing a restart
at launch would be worse than the version gap. It waits for the splash and stays
out of the way while settings are open, where the same update is already offered.
The condition lives in `promptedUpdate` so those four cases are tested rather than
buried in JSX.

**The dialog is reachable in a dev run.** `tauri dev` has no updater endpoint, so
the real check can only ever answer "up to date" — which left the one piece of UI
that matters here visible only on a real release.
`REKORD_DEV_UPDATE=1 npm run tauri dev` makes the check answer with a mock
instead, and `=critical` / `=important` fakes that level — the flag doubles as
the marker, so an unknown value is ordinary there too. Its notes say so in their first line: a fake that looks real
is a support question waiting to happen. Installing it ramps the progress and then
fails on purpose, because there is no artifact and a silent success would relaunch
into the same version.

**What is left** — the *signed* path (a real `latest.json`, a real download)
still only proves itself on the next release. What the mock covers is everything
above it: the marker, the banner, the notes, the prompt.

*Size: S*

### F6 · `docs/COMMANDS.md` — **done**

**What shipped** — [`COMMANDS.md`](COMMANDS.md): every command grouped by feature
area with its arguments, return, events and frontend wrapper, plus a table of all
eleven events and their payloads. The definitions and the `generate_handler!`
list agreed exactly when it was written, and the file gives the `grep` that
re-checks that instead of asserting a count that goes stale.

**Two rules stated once instead of forty times.** Arguments are camelCase in
`invoke` because Tauri renames them, while returns and event payloads stay
snake_case because no model carries `rename_all`. And `AppResult<T>` rejects with
a string where a plain return type cannot fail at all — `write_metadata`, the
three deletes and `bandcamp_download` report failure *inside* the value, which is
the thing a caller gets wrong.

**Writing it down found four things.** `cancel_scan`, `cancel_dedupe`,
`dedupe_status` and `dedupe_result` are registered and wrapped with no UI caller,
and `start_scan(force = true)` is in the same position; `STAGE_WAVEFORM` has no
counterpart in `src/types.ts`; `AUDIO_EXTENSIONS` exists twice, loudly on the Rust
side and silently on the TypeScript one; and four commands are `serde_json::Value`
in Rust while TypeScript asserts a shape. All four are in [`TODO.md`](../TODO.md);
none of them is a bug today, and all four are the shape drift takes.

*Size: S · done*

### F7 · `TODO.md` with recorded deferred decisions — **done**

**What shipped** — [`TODO.md`](../TODO.md) at the repo root, one entry per
decision in the form *What* → *Why not* → *What would change that*.

**Where the boundary runs.** This file stays the roadmap — things we could do,
with a size. `TODO.md` holds the other half: measured rejections (B4, the chroma
log-compression, a narrower default tempo range), the follow-ups split off when a
parent item shipped (C1a, C1b, C2a, C5a, C7, C8), the legacy JSON key, and the
findings from writing F1 and F6. The reasoning is moved or linked, never argued
twice — the *Deliberately not adopted* section below stays here and `TODO.md`
points at it.

**The condition is the load-bearing field.** "Not now" without a trigger is a
note rather than a decision, and it is what makes a list like this rot. C7 is the
one entry whose condition is "nothing, this should just be done", and saying so is
more useful than pretending it is waiting on evidence.

*Size: S · done*

---

## G — Reach and test depth

### G1 · End-to-end tests — **done, in two layers**

**What shipped** — two levels rather than one, because the cheap one is where
the coverage comes from and the expensive one is where the claim comes from.
Full detail in [TESTING.md](TESTING.md).

- **Flow tests** (`src/e2e/*.e2e.test.tsx`, 30 tests over seven flows: first run,
  scan, convert, duplicates, metadata, undo, Bandcamp). The real frontend in
  jsdom against one fake backend wired in at the `invoke` boundary
  (`src/test/fakeBackend.ts`), so `App.tsx` → `lib/api.ts` → `invoke(…)` runs for
  real. They ride in `npm test` and gate every push.
- **End-to-end specs** (`e2e/*.spec.ts`) driving the built app through
  WebdriverIO, asserting against the filesystem: the tempo really is written
  into the file, and a conversion really is renamed over its source. On demand
  and before a release (`.github/workflows/e2e.yml`), never on every push.

**The item as written could not be built.** `tauri-driver` supports Windows and
Linux only — there is no WKWebView driver tool — and macOS is the only target we
ship. That, not effort, is why this sat untouched. `@wdio/tauri-service` with
`driverProvider: "embedded"` runs the WebDriver server inside the app instead,
and covers WKWebView.

**The automation server cannot reach a release.** It is an optional dependency
behind a `wdio` Cargo feature, and `lib.rs` fails to compile it when the feature
meets `not(debug_assertions)` — which every `tauri build` is. `e2e.yml` asserts
that refusal still happens.

**The counts this entry used to carry were stale, so it names none.** Re-derive
them: `npm test` and `cd src-tauri && cargo test` both report totals.

**Deliberately not bought:** `browser.tauri.*`. Its plugin evaluates scripts
with `eval` inside the page, and our CSP has no `'unsafe-eval'` — a suite that
proves an app with a weaker CSP than the shipped one proves the wrong app. The
cost is a five-second probe on every WebDriver call, which is why the e2e specs
assert against files rather than the DOM.

**What is left** — three gaps in `TODO.md` are narrowed rather than closed:
`metadata::write::finalize`, `metadata/artwork.rs` and
`audio::dedupe::find_duplicates` are exercised through the app now but still have
no test of their own, and the conversion's three cleanup branches are only
reachable by making ffmpeg fail mid-run.

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

## I — Interface and playback

What the app looks like while it is being used, and what it does while a track
is playing. Everything here is small next to the tiers above and none of it is
speculative — each entry is something a person using the app asked for after
looking at it.

### I1 · An expanded group has to look expanded

**What** — an album, folder or playlist row that is open should differ in
surface, not only in the direction of its chevron. A step lighter than the
collapsed default.

**Why** — the open/closed state is the thing a user scans a long list for, and
right now it is carried by a 14 px glyph. Reported from a screenshot: the
container reads as closed at a glance even when it is open.

The styleguide constrains the answer, which is the useful part of this entry.
Depth comes from surface levels rather than shadows, and there are three
(`bg`, `surface`, `surface-2`) — so "lighter" means the next level up and a
`border-border-strong` hairline, not a new colour. If three levels turn out not
to be enough to say *contains the row below it*, that is a styleguide question
and belongs in `docs/brand/STYLEGUIDE.md` before it belongs in a component.

*Size: S*

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

### I3 · Edit a playlist in a dialog

**What** — one overlay that reorders, renames and removes, instead of the
per-action menu entries A1 shipped.

**Why** — A1 built the right model for this: membership is explicit position
rows rather than an implied query order, so reordering is a cheap write and not
a rebuild. The UI is what has not caught up — `PlaylistMenu` and
`AddToPlaylist` cover create, rename, delete and add, and there is nowhere to
see a playlist as a list and move a track within it.

Note what it must not become: a second place where playlist state lives. The
dialog edits through the same commands, and the ordering logic stays in
`src/lib/` where it is testable, as A1 specified.

*Size: S · depends on A1, which shipped*

### I4 · The player says which album

**What** — album name in the player bar next to title and artist.

**Why** — asked for directly. It is also the field that tells two versions of
the same track apart, which is exactly what a library full of near-duplicates
needs while one of them is playing.

The work is not the field, it is the width. The bar already runs `MarqueeText`
over the title because the space is not there, so adding a third value is a
decision about what gets truncated first at a narrow window — and that decision
is worth making once, in the styleguide's terms, rather than per field.

*Size: S*

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
