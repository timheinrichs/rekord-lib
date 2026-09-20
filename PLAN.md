# Plan — a track you can open, and a grid you can move

## Version

**0.10.0 → 0.11.0 (MINOR).** Two user-facing capabilities that did not exist: a
surface that shows one track instead of all of them, and a beat grid that can be
corrected by hand. At `0.x` that is a MINOR. Nothing breaks — a database that
never sees a hand-set grid behaves exactly as it does today.

The plan proposes the number; the bump waits for the maintainer's go.

## Why these four, and why two releases

Asked for: **A3** (read an existing `rekordbox.xml`), **A4** (cue points),
**B8** (move the beat grid), **I2** (settings for playback). Three of them wait
on the same missing thing, and `TODO.md` has said so since 0.8: the grid is
stored and exported but never drawn, because the row waveform is 112 px for a
whole track and at that scale the beats of a 128 BPM track are under a pixel
apart. A4 says the same about placing a cue; B8 says it about dragging an
anchor. **I2's larger, playhead-following waveform is the prerequisite for both
of them**, and A3 is the one item that stands alone.

So: **0.11.0 is I2 and B8** — the surface gets built and immediately earns
itself. **0.12.0 is A4 and A3**, on top of it, with its own plan. This file
outlines 0.12.0 only far enough that 0.11.0 does not build a surface the cues
cannot live on.

## The surface

**"Track"** — `src/components/TrackView.tsx`, beside the other four views. The
tabs answer *which tracks*; this one answers *this track*. Not "Deck": that
claims performance, and a name is a claim.

Built exactly like Settings (`src/App.tsx:416-443` is the template): a sibling
`div.animate-fade-in`, its own `AppHeader` with the title closing it, the three
main views going `hidden` rather than unmounting so a running scan survives the
detour. In flow, not `fixed` — `animate-fade-in` touches `transform`, and
`App.tsx:74-79` records what that does to a fixed child. `surface` at `:292`
gains a case, `settingsOpen` still wins so there is never a second `h1`, and
`src/test/appDom.ts` gains a helper beside `settingsView`.

Two entrances, one invariant: **the surface is always the player's current
track, enlarged.** From a row (`LibraryView.tsx:1742`, beside the play button)
it calls `play()` first — a scrolling playhead with no audio is useless, and B8
needs you to *hear* the beat you are dragging onto. From the player bar, an
expand toggle. `player.close()` drops `current` to `null` and the surface closes
with it.

**No transport and no overview on it.** The `PlayerBar` stays mounted and
visible: it already carries prev/play/next, the time readout and — as its 40 px
waveform — the whole-track overview and the seek. Duplicating four controls on
an app that has `I6` open about a crowded header would be the wrong trade. So
`player.tsx`'s `paddingBottom = "5rem"` stays correct and untouched, and the
surface is `AppHeader` plus a `min-h-[calc(100dvh-4rem)]` body.

What it adds: the **lane** (the zoomed waveform, 160 px, playhead fixed at the
centre, audio scrolling under it), a **ruler** with bar numbers at the downbeats,
the **zoom** control, the **volume**, and the **grid card**. Room for 0.12.0's
cues is a geometry constant (`MARKER_LANE_PX`, already excluded from the drawing
height) and an empty second column in a `lg:grid-cols-2` — *not* an empty "Cues"
card, because a placeholder is a promise.

It takes no new number in the layer stack (filter bar 20, header 30, menus 40,
modal 50, transient 60): it is a page, not a floating thing, which is half the
reason it is not a modal. It is also not a persistent region, so it does not
pre-empt `I6`. And nothing on it may carry `backdrop-blur` — the
No-Blur-Over-Motion Rule exists for precisely a surface whose content moves
every frame, and the player bar already paid that bill once.

## The playhead, per frame

Position today comes only from `<audio onTimeUpdate>` (`player.tsx:256`), ~4×/s,
in its own `ProgressCtx` so it cannot re-render the track list. That stays.
`PlayerApi` gains exactly one member:

```ts
/** The element's position in seconds, read straight off the audio element.
 *  For a per-frame consumer only: it is not state and re-renders nothing. */
currentTime: () => number;
```

A getter, not the ref: handing out `audioRef` hands out `play()`, `src` and the
audio session — each of them a way around the coalescing mitigation documented
at `player.tsx:149-165`, which nothing here may touch.

A new `src/lib/usePlayhead.ts` owns the app's **first** `requestAnimationFrame`
loop: one chain, one cancel path, the callback held in a ref so a re-render does
not restart it, and it never calls `setState`. A leaked rAF is a permanent 60 Hz
wakeup on a laptop, so the cancel gets its own test.

Drawing maths lives in `src/lib/gridLane.ts`, pure and testable: `laneWindow`
(the playhead stays centred *always*, including at both ends — a playhead that
drifts off centre at the edges lies about where the centre is), `xAtTime` /
`timeAtX`, `beatsInWindow`, `barNumber`.

Per frame there is no column loop: one `drawImage` from an offscreen tile, the
beat lines (≈107 `fillRect`s worst case), the playhead and the ruler text. The
tile is a **sliding 3×** window — three lane widths, rebuilt when the playhead
has travelled half a span, so the column loop runs about once every eight
seconds of playback instead of sixty times a second. A whole-track tile is
rejected with its arithmetic: 150 device px per second at the default zoom is
17 Mpx ≈ 69 MB of backing store for a six-minute track, per zoom level.

The tile's loop is `Waveform.tsx:59-77`'s, with one addition: **two modes**,
picked by comparing bins in the window to device pixels — *pixel-major* (today's
max-reduce) at the shallow zooms, *bin-major* (one rect per bin, ≥ 1 px) at the
two deepest. Stopping where the data stops is the same discipline as not
claiming more than has been measured.

**Reduced motion.** `DESIGN.md` requires every animation off, and
`[class*="animate-"]` cannot reach a canvas. So under the query there is **no
rAF at all**: the lane redraws on `usePlayerProgress`'s 4 Hz `time` and the
window re-centres in steps. Two sibling components under one picker
(`ScrollingLane` / `SteppedLane`) over one imperative core, so there is no
conditional hook and the rAF path never subscribes to `ProgressCtx`. `DESIGN.md`
gains the sentence, because the rule has to cover the case before the code does.

## The high-resolution waveform

The stored waveform is 2400 bins for a whole track (`audio/waveform.rs:26`) —
about 7 a second, an envelope, not a beat. Raising `BINS` would bump
`waveform::ALGO_VERSION`, invalidate every stored waveform and re-decode the
whole library. Instead the **on-demand command** is extended; it already
computes and stores nothing, and its doc at `commands.rs:962-969` already says
the dense variant is a different artefact.

- `waveform(path, bins: Option<usize>)`; `analyze` takes and clamps the count;
  `reduce` (`:65`) is already parameterised. `BINS` and `ALGO_VERSION` do not
  move — they version the bytes in the `waveforms` table, and those bytes do not
  change.
- `DETAIL_BINS_PER_SEC = 200.0` — a **5 ms bin**, the same order as the beat
  detector's own resolution, and within a pixel of the three decimals the export
  writes for `Inizio`. At the default 16 s zoom that is 1.15 bins per device
  pixel on a 1392 px lane: pixel-major, today's loop exactly.
- `MAX_BINS = 120_000` — ten minutes at the full rate, and the only thing
  between a frontend bug and a gigabyte. A longer track gets a longer bin, which
  is the right way to degrade.
- Six minutes is 72 000 bins ≈ 1.2 MB in memory and ~1 MB of JSON, once per
  track opened, never per frame. **Measure it on a real file first.** Two named
  fallbacks, in order: 100 bins/s (one constant), or the packed `to_bytes` form
  through `tauri::ipc::Response`.
- A **separate** wrapper: `detailWaveform(path, bins)` must not go through
  `api.ts:446`, which consults `stored_waveforms` first and would be satisfied by
  a 2400-bin blob. `waveform(path)` keeps its behaviour, so the bar and the row
  are untouched.
- `createWaveformCache(2)` lives in `App`, not in the surface, so closing and
  reopening does not re-decode. Two entries ≈ 2.4 MB, stated as a budget.
- **Never a blank rectangle**: the coarse stored overview draws immediately and
  is replaced in place when the detail array lands, with a `text-fg-muted` line
  saying so while it is pending and on failure. The grid controls are live
  throughout — they depend on numbers, not on the picture.

## Volume

`Settings.volume` (0..1, default 1) in `src/lib/settings.ts`, persisted — a
volume that resets every launch is the complaint. `loadSettings` drops unknown
keys but validates no values, so this brings the file's first per-key check,
`clampVolume`, deliberately and with a test.

`PlayerProvider` takes it as a defaulted prop from `App.tsx:315` and applies it
in one effect that touches neither `src` nor `play()`, so it cannot re-enter the
audio-session race. Two controls, one source of truth, both writing
`updateSettings({ volume })`: a new **Playback** card in Settings (which is
literally what I2 asks for, and which also holds the default zoom), and one on
the surface — a volume you have to open Settings for is not a volume control.
**Not in the player bar**, which is already eight controls wide and is exactly
what `I6` is open about. `DESIGN.md` counts "the seven settings sections" in
prose, so that number moves too.

A range input is new: `designRules.test.ts`'s `FIELD` regex demands the control
radius on every `<input>` and exempts only `checkbox|radio`. Extend the
exemption to `range` **with its own assertion**, so the hole is deliberate.

**One honest scope note.** I2 asks for a setting for "how the waveform is shown
(larger, and scrolling …)". With the surface that stops being a toggle: the bar
keeps the overview it was designed for, the surface is the scrolling one, and
what persists is the default zoom. Both behaviours ship, in the two places they
belong — and the CHANGELOG says it in those words rather than implying a switch.

## The grid, drawn and then moved

**Drawn first.** Beat lines from `beat_offset_secs` and the tempo, downbeats
taller and in `accent-300`, plain beats in `graphite-700` (the colour
`DESIGN.md` already names for the grid under the canvas), playhead in `fg` so it
is never mistaken for either. That alone closes the `TODO.md` entry *"The beat
grid is stored and exported, but not drawn"*, and it is the natural release
boundary if 0.11.0 has to be cut short.

**Stored in its own table, not on the row.** A rescan rewrites the whole `tracks`
row, and `invalidate_on_version_change` nulls the identity columns on *every*
release, so a hand-placed anchor in `tracks` would survive only as long as every
write site remembers a flag. The established answer is the `edits` idiom: a
separate table, overlaid on read, never merged into the row. `SCHEMA_VERSION`
10 → 11; a new table needs no `upgrade` arm.

```sql
CREATE TABLE IF NOT EXISTS grid_edits (
    path        TEXT PRIMARY KEY REFERENCES tracks(path) ON DELETE CASCADE,
    offset_secs REAL    NOT NULL,   -- the anchor, folded into [0, period)
    bpm         REAL    NOT NULL,   -- the tempo it was placed against
    downbeat    INTEGER NOT NULL,   -- which beat of the bar it is, 1..4
    edited_ms   INTEGER NOT NULL
);
```

The foreign key is the one deliberate divergence from `edits`, which has none:
cascade means a deleted track cannot leave the row behind, and it means a
`relocate_tracks` that forgets the table fails at `COMMIT` instead of quietly
losing user data. `cue_points` in 0.12.0 will be keyed the same way, so this is
one idiom twice rather than two idioms once.

Because nothing lands on `tracks`, `TRACK_COLUMNS`, `TRACK_COLUMN_COUNT`,
`row_to_track` and `upsert_tracks` are untouched — and `commands.rs:757-768`,
`wants_tempo` and `grid_matches_tempo` all stay exactly as they are.
`beat_offset_secs` becomes unambiguously *what the detector last found*, which
is what "Reset to detected" needs to exist.

Three sites do change, and `db/mod.rs:426-441`'s war story is why they are named
here: `relocate_tracks` **carries** the rows; `replace_track` **carries** them
too — the exception to its "what deliberately does not move" list, because a
conversion re-encodes the same audio and does not move a beat (the caveat to
write down: a *lossy* source can shift by the codec's priming, and the row is
carried anyway, because discarding what somebody placed by hand is worse than a
few milliseconds they can see); `delete_tracks` needs nothing, the FK cascades.

Commands `grid_edits_load` / `grid_edit_set` / `grid_edit_clear` copy the
`edit_*` shapes exactly (`db::require`, a scoped guard, no announce), register in
`lib.rs`, get wrappers in `src/lib/library.ts`, a `GridEdit` in `src/types.ts`
and three handlers plus a `gridEdits` slice in `src/test/fakeBackend.ts` — an
unknown command throws, so this is not optional.

**The tempo does not live in that table.** A hand-corrected tempo (÷2, ×2) is a
pending metadata edit, written through the existing `edit_set` path — the same
thing typing a BPM in the metadata editor does. One tempo, one place: the table
and the grid cannot disagree, the export change is *zero* (`edit_overlay`
already feeds `md.bpm`, which already writes `AverageBpm` and `<TEMPO Bpm>`),
applying it writes the tag through a path that already has undo, and discarding
it is the existing discard-a-pending-edit mechanism. This is the decision most
likely to be undone by accident during implementation, which is why it is
written down.

**Moving it.** A visible `Seek` / `Move grid` mode toggle, not a modifier — a
modifier is undiscoverable, and a visible mode is what stops a scrub from
nudging somebody's grid. In *Move grid*: drag the anchor (pointer capture,
listening on the **window** and not on the node, which is the lesson `597145b`
and `415482b` already paid for), a click without movement snaps to the nearest
beat and makes it beat 1, and a `1 2 3 4` segmented control says which beat the
anchor is — the value `Battito` has asserted since A2 and B3 never detected.
Beside the lane, the path most corrections will actually take: **"Set the anchor
to the playhead"**, ±5 ms nudges (one detail bin, so a nudge is always visible)
and a readout to three decimals, the export's own precision. Halve and double
are labelled with the *result* (`64.00`, `256.00`), each writing both halves in
one action. Snap-to-grid is session-only and snaps the **playhead while
seeking**, never "set the anchor to the playhead" — snapping the playhead to the
grid and then setting the grid from the playhead is the no-op loop that is the
bug in every first grid editor. "Reset to detected" clears the row; there is no
undo stack, because four numbers with the detected value still sitting next to
them is a clearer contract than a history.

**The export.** `track_xml` resolves first, then writes: the hand-placed
`Inizio` where there is one, `Battito` from the stored downbeat instead of the
literal `1`, `Bpm` unchanged in code and moved in value by the edit overlay,
`Metro` still `4/4` because nothing in the app knows a time signature.

**A risk that gates half of it:** `Battito != 1` has never been through a real
Rekordbox import. Confirm it against a real export before shipping the export
half — the same discipline A4's entry demands for `POSITION_MARK`. The
always-valid fallback is to keep `Battito="1"` and move `Inizio` to the declared
downbeat instead.

## 0.12.0 — A4 and A3, outlined only

- **A4 storage**: `cue_points(path, ordinal, num, position_secs, name, colour,
  created_ms)`, PK `(path, ordinal)`, whole-list writes like `set_playlist_paths`,
  and a *partial* unique index on `(path, num) WHERE num >= 0` — `num` is the
  single field the two kinds differ by (`-1` memory, `0..7` hot), so nothing has
  to be translated on the way out. Marks store absolute seconds; "is this mark
  on the grid" is derived, never stored. When B8's grid moves, the surface
  *offers* to carry the marks that sat on the old one — never automatically.
- **A4 export**: `track_xml`'s tail decides "self-closing or has children" from
  the grid alone; it becomes a collected `Vec<String>`. **Land that refactor in
  0.11.0**, with the existing tests unchanged, since `Battito` touches those
  lines anyway.
- **A4 is gated on a verification step.** The `Num="0..7"` / `Num="-1"` names
  are the one part of this format never read off a file Rekordbox wrote. A real
  export with both kinds has to be produced and read *before* a mark is written,
  and `scripts/rekordbox-reference.py` has to learn `<POSITION_MARK>` — as a
  `--marks` side output, so `bpm_reference.csv` is not regenerated. If no such
  export can be produced, cue storage and UI ship without the export half,
  exactly as A2 did, and `TODO.md` gets the entry with its condition.
- **A colour question for `DESIGN.md` first.** The One Accent Rule says violet
  is the only brand colour and the three hues are verdicts. A hot cue's colour is
  neither — it is data from the player's palette. Either cues ship monochrome
  with their letter doing the work, or the rule gains a stated exception. Either
  way the two kinds are told apart by **shape**, not by colour.
- **A3**, scoped to *playlists plus Rekordbox's BPM and key as reference
  values*: the collection is not adopted, and an XML track with no match is
  reported, never created. `quick-xml` is already compiled in this tree via
  `plist`, so it costs a `THIRD_PARTY_LICENSES.md` line and no new crate; a
  `DOCTYPE` is refused outright, which kills entity expansion by construction.
  Matching is a ladder — exact, then NFC-folded (the documented 26-of-2219
  case), then basename plus duration — and two candidates is *ambiguous*, not a
  match. Folder trees flatten into `House / Deep / 2024 promos`. Preview and
  apply are two commands with a digest between them, so nothing is written
  before it has been seen. `/security-review` is mandatory on that diff.

## Tests

- **Rust** — a bin count is honoured and an absurd one is clamped; a hand-placed
  grid wins over the detected one; `Battito` says which beat the anchor is; a
  track with no grid edit exports the byte-identical string it does today; a
  relocation carries a grid edit; a replacing conversion carries the grid but not
  the metadata edit; a v10 database gains the table on the next start; **a
  rescan does not touch a grid edit** — the claim the whole storage decision
  rests on.
- **Frontend unit** — `beatGrid.ts` (fold a negative anchor the way `beats.rs`
  folds one, halve/double preserving phase, snap at the midpoint), `gridLane.ts`
  (window at both ends, `xAtTime`/`timeAtX` round-tripping sub-pixel, the
  pixel/bin-major crossover), `usePlayhead` (starts, stops, **stops on
  unmount**, never starts under reduced motion), the volume clamp. Canvas
  components mirror `Waveform.test.tsx`: survives no 2d context, survives empty
  data. `Waveform.test.tsx` itself stays green unchanged — that is the assertion
  that the bar did not move.
- **Flow (`src/e2e/`)** — the wiring nothing else sees: opening from a row and
  from the bar hides the three views; the detail request is
  `("waveform", { path, bins })`, which is the one level that catches a renamed
  argument; a drag writes one `grid_edit_set`; reset writes `grid_edit_clear`;
  halving writes *both* a metadata edit and a grid edit and the library row shows
  the new tempo; closing the player closes the surface; the volume survives a
  reload through the real store handlers; a rescan does not clear a hand-set
  grid.
- **e2e (`e2e/`)** — `grid.spec.ts`: open the generated library's click track at
  its known tempo, move the anchor, **export and read the `<TEMPO>` line**. The
  only level that proves SQLite → overlay → writer → real file. Plus a smoke
  step that a large `bins` over a real six-minute file returns and does not take
  the app down, which is where the IPC cost is actually measurable.
- No `data-testid`, per `docs/TESTING.md`. The source-scanning guards stay green
  as long as the new controls are `h-9`, carry no `p-*`, and nothing uses
  `bottom-full`.

## Documentation, before the bump and not after

**New `docs/PLAYBACK.md`** — the player, both waveform paths, the surface and
the beat grid, in the house shape (*How it works* → *Deep technical details* →
*Implementation anchors* → *Verification links*), with a row in `docs/README.md`
in the same commit. Then: `docs/COMMANDS.md` (`waveform`'s new argument and why
`bins` never reaches the store; the three grid commands; the relocate paragraph's
must-carry list); `docs/SCANNING.md` (one sentence: the scan stores the overview
and nothing else); `docs/PLAYLISTS.md` (its export section asserts `Battito="1"`);
`docs/COMPARISON.md` (the *What we do not do* list gets shorter — the grid is
drawn and movable; the downbeat is still not *detected*); `PRODUCT.md` (the
"no performable beat grid" non-capability, and the aspiration paragraph, one
clause of which has just moved into the present — deliberately, not as a side
effect); `docs/CDJ_TEST_MATRIX.md` (a row for `Battito != 1`, marked **not
tested**); `docs/FUTURE_CONSIDERATIONS.md` (I2 and B8 deleted, their ids into
*Shipped*, A4's blocker line rewritten — tier I stays, because I6 is open);
`TODO.md` (the undrawn-grid entry leaves; three arrive with ids and conditions —
the grid is still not drawn on the 112 px row, a corrected tempo reaches the
export and the table but not the tag until it is applied, and `Metro` is `4/4`
for everyone; `STAGE_WAVEFORM has no counterpart in src/types.ts` is a waveform
session's to sweep up, and this is one); `CHANGELOG.md`, ordinary severity.
`CLAUDE.md` needs no change, and the release report says so.

## Order of work

Each step green — `npx tsc --noEmit`, `cargo check --tests` at **zero**
warnings, `npm test`, `cargo test` — before the next, and each its own commit.

1. **Volume.** The key, the clamp, the provider prop, the effect, the Playback
   card, the `designRules` exemption. A complete half of I2, shippable alone.
2. **`waveform(path, bins?)`.** The parameter, the two constants, the Rust
   tests, `detailWaveform`, the fake handler, `COMMANDS.md`. Green and invisible.
3. **The surface, read-only.** `TrackView`, the `App.tsx` wiring, the `appDom`
   helper, both entrances, coarse-then-detail drawing of the **detected** grid,
   zoom, the reduced-motion branch. At the end of this step the `TODO.md` entry
   is satisfied — the release boundary if 0.11.0 has to be cut.
4. **`grid_edits`.** Schema 11, the db functions, relocate/replace, the three
   commands, the wrappers, the types, the fake backend, the four db tests.
5. **The export.** The children-`Vec` refactor, the overlay, `Inizio`/`Battito`,
   the golden string, the reference script's new field, the e2e XML test. Still
   no UI: a grid edit written by a test already reaches the file, which is the
   cheapest way to prove the chain.
6. **The interaction.** Mode toggle, drag, set-to-playhead, nudge, downbeat,
   halve/double with its metadata half, snap, reset.
7. **Docs, `/code-review`, `/security-review`** (short — nothing here touches
   untrusted input, a bundled binary or a capability scope, but the checklist
   asks), a `/run` click-through, then the bump on the maintainer's go.

## Risks

- **The app's first rAF.** One hook, one cancel path, a test for the cancel, and
  the loop gated on `playing && open && !reduced`.
- **The WebKit audio session** (`player.tsx:149-165`). The only new access is a
  read-only getter and a `volume` write; neither activates the session. Verify by
  skipping through ten tracks in a real `tauri dev` run with the surface open.
- **~1 MB of JSON per open track.** Measured before 200 bins/s is committed to;
  two fallbacks already named.
- **A grid edit not carried by a relocation or a conversion.** Two db tests, and
  the doc paragraph that already tells this story gains the table's name.
- **`Battito != 1` is unvalidated** against real Rekordbox and real hardware.
  Confirm before shipping the export half; the fallback is written down above.
- **Scope creep into A4.** The room for cues is a constant and a grid column.

## Not in scope

Cue points, the XML import, ANLZ files and anything that writes the USB drive
(H1); a variable-tempo grid, which `audio/beats.rs:7-12` rules out on purpose; a
time signature other than 4/4; any change to `waveform::ALGO_VERSION` or to the
stored waveform; widening `grid_matches_tempo` to a power-of-two ratio, which
would let a corrected track grow a fresh detected grid and is a `TODO.md` entry
rather than this release's problem.

## Verification

`npx tsc --noEmit`, `cd src-tauri && cargo check --tests` at zero warnings,
`npm test`, `cargo test`. Then `npm run tauri dev` against the generated
`.dev/library` — never `REKORD_DEV_REAL` — because neither unit nor flow tests
can say the wiring is right: open a track from a row and from the bar, play it,
watch the window follow, drag the anchor onto the click track's beat at its
known tempo, set the downbeat, halve the tempo, export, and read the `<TEMPO>`
line in the written XML. `npm run typecheck:e2e` and `npm run e2e` before the
release.
