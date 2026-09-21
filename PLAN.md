# Plan — marks on a track, and a collection read back in

## Version

**0.11.0 → 0.12.0 (MINOR).** Two user-facing capabilities that did not exist:
cue points, and reading an existing `rekordbox.xml`. At `0.x` that is a MINOR.
Additive at the schema (12), and nothing an existing library does changes.

The plan proposes the number; the bump waits for the maintainer's go.

## What this is the other half of

0.11.0 built the surface these two were waiting for. `A4`'s own entry said it:
*"The zoomed, playhead-following waveform in I2 is the prerequisite, and B8
waits on the same one."* B8 shipped, I2 shipped, and the track surface already
reserves the column a cue list goes in. `A3` never needed it and is here because
it is the last open item in tier A — when both land, the tier goes with them.

## A4 · Cue points

Two kinds, and the entry is explicit that a UI offering "a cue" without saying
which will reliably produce the other one: **hot cues**, the lettered marks a
player jumps to on a button press, and **memory cues**, the unlettered ones it
steps through. In storage and in the export they differ by a single field.

### The verification that gates the export half

`Num="0..7"` / `Num="-1"` is **the one part of this format never read off a file
Rekordbox wrote**. Everything else in `export/rekordbox.rs` was — the
`UNESCAPED` set records its 2219 locations. So before a single mark is written:

Set, in a scratch Rekordbox collection, all eight hot cues on one track with
different stock colours and two of them named, four memory cues on another, and
one track carrying both kinds at the same position. Export, read it, and record
in `docs/CUES.md` § Verification, with the Rekordbox version and the date: the
element name, **the attribute order Rekordbox writes**, `Num` for each kind
including which letter is 0, whether `Type` is present, how colour is written
and the eight stock triples, whether `Name=""` is emitted for an unnamed mark,
and whether `<TEMPO>` precedes the marks.

Until that exists the writer's constants sit in one block marked `// UNVERIFIED`
and `collection_xml` emits **no** `POSITION_MARK`. **If such an export cannot be
produced**, cue storage and the UI ship without the export half — precisely what
A2 did, for the same reason — and `TODO.md` gets `A4a` with the condition. What
must not happen is substituting a third-party description of the format for a
file Rekordbox wrote; that is the standard `rekordbox.rs`'s own header sets.

### Storage

A new table at `SCHEMA_VERSION` 11 → 12 — additive, so no `upgrade` arm:

```sql
CREATE TABLE IF NOT EXISTS cue_points (
  path          TEXT NOT NULL REFERENCES tracks(path) ON DELETE CASCADE,
  ordinal       INTEGER NOT NULL,          -- dense, time order, like playlist_items.position
  num           INTEGER NOT NULL,          -- -1 memory, 0..7 hot cue A..H
  position_secs REAL NOT NULL,
  name          TEXT NOT NULL DEFAULT '',
  colour        INTEGER,                   -- 0xRRGGBB, NULL where there is none
  created_ms    INTEGER NOT NULL,
  PRIMARY KEY (path, ordinal)
);
CREATE UNIQUE INDEX IF NOT EXISTS cue_points_hot_slot
  ON cue_points(path, num) WHERE num >= 0;
```

`(path, num)` cannot be the key: every memory cue is `Num="-1"`. The partial
index is what makes "one mark per letter" a rule the database holds rather than
a comment. Writes replace the whole list for a track, the way
`set_playlist_paths` does. `relocate_tracks` and `replace_track` must both carry
it — the war story in `db/mod.rs` is why that is named here — and on a merge the
**target's own marks win**: interleaving two sets under one ordinal produces a
set neither user made.

Marks store **absolute seconds**, not a beat index: `<POSITION_MARK Start>` wants
seconds, the waveform draws seconds, and a track with no grid must still carry a
mark. "Is this mark on the grid" is derived, never stored.

### What happens when the grid moves

B8 made the grid movable, so this is a case that exists now. Marks do **not**
follow silently: the surface offers to carry the ones that sat on the old grid
and says how far. A mark deliberately placed off-grid — a vocal entry, a sample
hit — must not be dragged onto a beat, and silently moving user data is what the
cache rules and Principle 4 exist to prevent.

### The colour question, which `DESIGN.md` answers first

The One Accent Rule says violet is the only brand colour and the three hues are
verdicts. A hot cue's colour is neither: it is data from the player's palette.
Either cues ship monochrome with their letter doing the work, or the rule gains
a stated exception for values the app did not choose. **That is a change to
`DESIGN.md` before it is a change to code.** Either way the two kinds are told
apart by *shape*, not by colour — a memory cue next to an uncoloured hot cue
must still read as the other kind.

### Export

`track_xml`'s tail decides "self-closing or has children" from the grid alone.
It becomes a collected `Vec<String>` of child elements, because a track can now
have marks and no grid. **Land that refactor first**, with the existing tests
unchanged and an empty mark list, so the part blocked on the verification is one
`extend` and one function.

`scripts/rekordbox-reference.py` learns `<POSITION_MARK>` as a `--marks` side
output rather than new columns: the committed `bpm_reference.csv` would
otherwise need regenerating for no measurement benefit. Without it the round
trip cannot see marks at all, and that check is the only reader in the export
that did not come out of the same head as the writer.

### Where a mark actually arrives

Through the Rekordbox export, which is the realistic path. Onto a CDJ without
Rekordbox in between it would need ANLZ files, which is H1. The UI says so once,
in the words `COMPARISON.md` already uses. How *many* hot cue slots a player
offers differs by generation — that is an `F4` row in the hardware matrix,
measured, not an assumption in the export.

*Size: L.*

## A3 · Read an existing `rekordbox.xml`

Scoped, and the scope is the point: **playlists, plus Rekordbox's BPM and key as
reference values**. The collection is not adopted. A track in the file with no
match in the library is **reported**, never created.

- **The reader** is `quick-xml`, which is already compiled in this tree via
  `plist` — so it costs a `THIRD_PARTY_LICENSES.md` line and no new crate. It
  streams, and it does not resolve entities. New module
  `src-tauri/src/import/rekordbox.rs`, mirroring the export: same format, one
  directory each way, and all parsing pure so it is testable without Tauri.
- **Untrusted input**, so `/security-review` is mandatory on that diff. A
  `DOCTYPE` is refused outright, which kills entity expansion by construction
  rather than by configuration; a size cap before the parse; caps on nesting,
  track and playlist counts and attribute lengths, each its own error. The
  structural defence is that **the import has no primitive that opens a path
  from the file** — a decoded `Location` is only ever compared against strings
  already in `tracks`.
- **Matching** is a ladder, first hit wins, and the tier is recorded so the
  preview can say *how* something matched: exact path; NFC-folded (the
  documented 26-of-2219 case); basename plus a duration within ±2 s. Two
  candidates is **ambiguous**, not a match.
- **Folder trees flatten** into `House / Deep / 2024 promos`. Our model is one
  flat ROOT node; a folder tree is a whole feature. Lossless in the sense that
  matters — no membership is lost — and visible in the preview before it is
  written.
- **Preview and apply are two commands**, not a flag, because nothing may be
  written before it has been seen. The apply takes the user's *decisions* plus
  the file's digest and re-parses; a file that changed in between is refused.
  An existing playlist defaults to **skip**, with replace and copy beside it.
- **The reference values** go in their own table, never into `tracks`: they are
  another program's verdict, they are never written into a file and never
  exported, and they exist to be compared against. Shown as two hidden-by-default
  library columns and on the track surface, in `text-fg-muted` — a tempo
  disagreement is not a compatibility verdict and must not wear those hues.
- **The app must not write `bpm_reference.csv`.** That file stays
  script-generated and hashed precisely so it says nothing about which music a
  collection holds.

*Size: M.*

## Order of work

0. **The verification** (above). First, because everything else proceeds in
   parallel and it may change a constant rather than a design.
1. Schema 12, `cue_points`, the db functions, relocate/replace, the rescan
   guard — **plus the `track_xml` children refactor**, existing tests unchanged.
2. `rekordbox-reference.py` learns `--marks`.
3. **A4's UI** — the cue layer on the track surface, the list, the two kinds
   kept apart by shape. The first user-visible slice, and complete without the
   export.
4. **A4's export**, blocked on step 0 alone.
5. **A3's reader and preview.** Writes nothing.
6. **A3's apply**, with the reference values.
7. The comparison columns, the docs pass, `/security-review`, `/code-review`,
   a `/run` click-through.

If 0.12.0 has to shrink, **A3 moves to 0.13.0** and A4 ships alone: A4 is
self-contained and A3 leaves nothing broken behind. The cut that must not be
made is shipping A3's apply without its preview.

## Risks

- **`Num` is wrong** → marks land on the wrong letters in somebody's player,
  which is worse than no marks. Answered by step 0 and by the `A4a` fallback.
- **The rescan cascade.** `cue_points` is `ON DELETE CASCADE` on `tracks(path)`.
  The scan's upsert is `ON CONFLICT(path) DO UPDATE`, so it is safe today; an
  `INSERT OR REPLACE` introduced later would delete every mark silently. That
  guard is a named test, as it is for `grid_edits`.
- **A silent wrong match on import**, answered by the ambiguity rule, the
  preview, and the fact that the import writes playlists and reference values
  only — never metadata, never a file.
- **`collection_xml` reaches six parameters.** At six it becomes a
  `Collection<'_>` struct rather than growing again.

## Not in scope

Loops, fades and load marks (`Type` other than a plain cue); ANLZ files and
anything that writes the USB drive (H1); adopting the collection on import;
playlist folders as a real tree; and `B8a`, the tempo's octave correction, which
is waiting on its own condition in `TODO.md`.

## Verification

`npx tsc --noEmit`, `cargo check --tests` at zero warnings, `npm test`,
`cargo test`. Then `npm run tauri dev` against the generated `.dev/library` —
never `REKORD_DEV_REAL` — to set marks on the click track, export, and read the
`<POSITION_MARK>` lines out of the written XML. `npm run e2e` and
`npm run typecheck:e2e` before the release.
