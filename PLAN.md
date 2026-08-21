# Plan — playlists, and a Rekordbox XML export

**A1 and A2** from `docs/FUTURE_CONSIDERATIONS.md`, the open half of the
*Interoperability* tier and the highest-value item on the whole list. Today the
handoff to Rekordbox is "the files are correct now, go import them", which
throws away everything the app knows beyond the tags.

**Version: MINOR 0.7.5 → 0.8.0.** Two features nobody has today, and at `0.x`
that is a MINOR whether or not anything breaks. (The plan proposes the number;
the bump waits for the go.)

## What the roadmap did not know: the beat grid is not stored

`analysis.beats` is computed on every analysis and then dropped. Nothing
persists it, nothing draws it, and `grep` finds no reader outside `beats.rs` and
`analysis.rs`. So `COMPARISON.md`'s "detected and drawn under the waveform" is
not true today, and B3's *What shipped* reads as though it were.

A2 writes `<TEMPO>` markers, which need exactly what the detector produces — a
period and a phase — so **A0** below persists them first. Two columns, in the
shape `bpm_confidence` already has. It also makes drawing the grid possible
later, which is what B3 said it was for.

## A0 · The grid gets somewhere to live

`tracks.beat_offset_secs` and `tracks.beat_confidence` (schema 9), written by
the analysis pass alongside the tempo, `null` where no phase was found. Same
invalidation as everything else on the row: mtime, size, app version. The
offset is relative to the analysed excerpt, so the export has to add the
excerpt's own offset back — that arithmetic lives in one place with a test.

## A1 · Playlists

**Tables** (schema 9, additive): `playlists(id, name, created_ms, updated_ms)`
and `playlist_items(playlist_id, path, position)` with a foreign key on both
sides and `ON DELETE CASCADE`, so deleting a playlist or a track cannot leave
orphans. Position is explicit and dense; the ordering logic — insert, move,
remove, renumber — is pure and lives in `src/lib/playlists.ts`, tested the way
`grouping.ts` is, not buried in a component.

**In the UI: a fifth grouping mode.** Flat / Album / Label / Folder /
**Playlists**, so the existing group machinery, the virtualised table and every
column carry over unchanged. Playlist heads carry a row count and a menu
(rename, delete, export). A track's position shows in the first column, because
in a playlist that number is what the row *is*.

**Reordering**: drag within a playlist, plus move up/down from the row menu and
the keyboard. Both, because drag is what people reach for and the menu is what
works when the list is 200 rows long and the target is off screen.

**Adding**: the selection has "Add to playlist" — the existing multi-select is
already the right gesture. Removing is per row and per selection.

## A2 · The export

`rekordbox.xml` through a save dialog: `DJ_PLAYLISTS` → `COLLECTION` with every
library track, `PLAYLISTS` with one node per playlist. Per track: the tags,
`AverageBpm`, `Tonality`, `TotalTime`, `Location` as a percent-encoded
`file://localhost` URL, and one `<TEMPO>` marker from A0. No cue points — the
app has no concept of one, and inventing empty ones would be worse than the
gap.

**The format is not guessed.** `scripts/rekordbox-reference.py` already reads
real exports from this maintainer's collection, so the field names, the
`Location` encoding and the `TEMPO` shape come from a file Rekordbox itself
wrote. The writer is checked against that reader: a round trip through the
script has to produce the rows it went in as.

## Tests

Pure logic first: `playlists.ts` (insert at a position, move across itself,
remove and renumber, a name that already exists), the XML writer against a
golden file, `Location` encoding for spaces, `#`, and non-ASCII in NFC and NFD.
Rust: the two new tables round-trip, cascade on delete, and the position stays
dense. A flow test for the wiring — create, add, reorder, export — because that
is the path that crosses the IPC boundary. And the export is read back by
`rekordbox-reference.py` in a test, which is the only check that speaks the
other side's language.
