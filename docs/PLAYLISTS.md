# Playlists and the Rekordbox export

Where the library stops being this app's business. Everything else here
prepares files; this is the part that hands them over.

```
Library table ── "Playlists" grouping ──────────────────────────────┐
  │  selection → Add to playlist  ─────────────┐                    │
  │  drag / ↑ ↓ / −                            │                    │
  ▼                                            ▼                    ▼
lib/playlists.ts  (pure: what the new order is)                     │
  │                                                                 │
  ▼  the whole list, never a diff                                   │
playlist_set ── playlist_items(playlist_id, path, position) ────────┤
                                                                    │
                                    "Export for Rekordbox" ─────────┘
                                            │
                                            ▼
                              export::rekordbox::collection_xml
                                            │
                                            ▼
                                     rekordbox.xml
```

## Why membership is its own table

`playlists` holds the identity and the name; `playlist_items` holds
`(playlist_id, path, position)`. Two tables rather than a list on the playlist
row, because the **order is the content** — a playlist whose order is implied by
whatever a query returned is a set, not a list, and a DJ set is not a set.

Both foreign keys cascade. Deleting a playlist takes its rows; a track leaving
the library takes its memberships. An orphan here would be a position pointing
at nothing, and the export would have to invent a track for it.

A track cannot be in the same playlist twice — the primary key is
`(playlist_id, path)`. Rekordbox allows it; nothing has asked for it here, and
until something does, adding a track that is already in a playlist is a no-op
rather than a duplicate row nobody meant.

## The order is written whole, never as a diff

`playlist_set` replaces a playlist's contents with exactly the array it is
given. Three reasons, in order of weight: the order *is* the payload; a single
reorder rewrites most of the positions anyway; and a playlist is tens or
hundreds of rows, not the scale where a diff earns its complexity.

The consequence is the useful part — exactly one place has to be right about
what the new order is, and it is pure:

| `src/lib/playlists.ts` | |
| --- | --- |
| `addToPlaylist` | appends what is not already there |
| `removeFromPlaylist` | takes rows out |
| `movePlaylistItem` | one row to an index |
| `movePlaylistItems` | a selection in front of a row — the drag |
| `stepPlaylistItem` | one row up or down, expressed as the same move |
| `uniquePlaylistName` | a name that is not taken |
| `wouldAdd` | how many of a selection a playlist would actually gain |
| `buildPlaylistGroups` | the grouping's heads and their tracks |

`stepPlaylistItem` sharing the drag's rule is deliberate: moving *down* has to
aim one row further along than it looks, because the track is lifted out before
it is put back. Off by one there and a track swaps with itself, which reads as a
button that does nothing. A test asserts the two ways of reordering agree.

At the ends nothing happens, and it happens by returning *the same list* rather
than an identical copy — that identity is what lets the caller skip a write for
a button press that changes nothing.

## In the UI it is a grouping, not a sidebar

Flat / Album / Label / Folder / **Playlists**. The virtualised table, every
column, the selection and the group heads carry over unchanged, and the window
keeps its shape.

- The order comes from the playlist, **not** from the sort — the one grouping
  where the rows are not sorted, because the order is the content.
- The position sits in the chevron's column. A track row has nothing to expand,
  so that cell existed only to keep the columns in line; in a playlist the
  number is what the row is.
- **Unsorted** is always there, even empty. It is where a track lands when it
  leaves a playlist, and a bucket that appears only sometimes is one nobody
  learns to look in.
- "Add to playlist" says what each entry would do — `+3`, `+1 of 4`, or
  `already in` for one that holds the whole selection, which is then not
  clickable. Said rather than hidden: it is also the answer to "are these
  already in there?".
- A path with no visible track is skipped rather than drawn empty: it may be
  filtered out, or the file may be gone and the row already pruned.

Every change is optimistic and then reconciled — the new order is on screen
before the write returns, because a drag that snaps back reads as a failed drag,
and the re-read afterwards is what makes the view agree with the database again,
including where the database dropped a path the library no longer holds.

## The export

`export_rekordbox_xml(dir, dest)` writes a `DJ_PLAYLISTS` document: a
`COLLECTION` of **every track in the library** and a `PLAYLISTS` node per
playlist. The whole library, not only what is in a playlist, because the
collection is what Rekordbox imports tracks *from*.

Per track: the tags, `AverageBpm`, `Tonality`, `TotalTime`, `SampleRate`,
`Kind`, `DateAdded`, a percent-encoded `file://localhost` `Location`, and one
`<TEMPO>` marker where a beat grid exists.

**A pending metadata edit is what gets written.** One made in the editor and not
yet applied to the file overrides the tags on its row, so the xml says what the
table says. `db::load_edits` still hands out opaque JSON; `export::rekordbox::
edit_overlay` is the one place in the backend that reads its shape, it reads it
leniently, and a payload it cannot parse exports the row's own tags rather than
failing the run. The edit *replaces* the metadata rather than merging into it —
the same rule as `metaOf` in `src/lib/grouping.ts` — so a field the editor
cleared is cleared here too, and an edited tempo moves the `<TEMPO>` marker's
period while keeping the detected phase.

**What is deliberately absent.** Cue points — the app has no concept of one, and
inventing empty ones would put marks in somebody's player that nobody set.
`Size`, which a track row does not carry. And for a track with no tempo,
`AverageBpm="0.00"`, which is what Rekordbox writes for "not analysed" rather
than a number we made up.

**One marker, and it claims beat 1 without knowing it.** Our detector produces
one tempo per track, so a grid is a period and a phase (**B3**); `Metro="4/4"`
and `Battito="1"` are what the format wants, and the bar position is not
something we detect. The phase is stored on the *track's* clock — the detector
counts from the start of its 120 s excerpt, which usually begins 30 s in, so the
raw number would put every beat half a minute early.

**The format is not guessed, and the `Location` encoding is not either.** Every
attribute name, the `TEMPO` shape and the `NODE` shape were read off a real
export (`rekordbox 7.2.17`, 2219 tracks). Two things that came out of comparing
against it rather than reasoning about it:

- **Rekordbox leaves `, ( ) ! + # $ @ ?` unescaped** and escapes the space, the
  apostrophe, the ampersand and every non-ASCII byte. Our encoder now agrees on
  all 2219 locations, down to the byte, with the sole exception of hex letter
  case — where the export disagrees with *itself* (`%c3` in some rows, `%D0` in
  others), and where RFC 3986 says the two are equivalent.
- **That agreement is not cosmetic.** Rekordbox matches an imported track to one
  it already holds by comparing this string. The same file written with a
  different-but-valid encoding reads as a second file, so an import into an
  existing collection would quietly duplicate every track with a bracket in its
  name.

`scripts/rekordbox-reference.py` is the second check, and the one that runs in
CI: what the writer produces goes back through the reader that was built for
real exports, and has to come out as the rows it went in as.

**The export itself is deliberately not in the repository** — it lists a whole
personal collection with absolute paths, which is why `DSP_BENCHMARK.md` keeps
only a hashed distillation. Re-verifying the encoding therefore means pointing
the comparison at a fresh export by hand; the method is in this section, not in
a test.

**The save dialog is why `dialog:allow-save` is in the capability.** This is the
one file the app writes outside the library folder it was given, and the path
comes from a native panel the user drove.

## Implementation anchors

| Where | What |
| --- | --- |
| `src-tauri/src/db/schema.rs` | `playlists`, `playlist_items`, and why the position is explicit |
| `src-tauri/src/db/mod.rs` · `load_playlists`, `all_playlist_paths`, `set_playlist_paths` | reading the list, reading every membership at once, writing one whole order |
| `src-tauri/src/commands.rs` · `playlist_*`, `export_rekordbox_xml` | the command surface |
| `src-tauri/src/export/rekordbox.rs` · `collection_xml`, `track_xml`, `location_url`, `date_of_ms` | the document, and the two encodings that are easy to get wrong |
| … · `edit_overlay`, `EditOverlay` | the one place the backend interprets a pending edit, and how leniently |
| `src/lib/playlists.ts` | every ordering rule, pure |
| `src/lib/usePlaylists.ts` | the state, and the optimistic-then-reconciled write |
| `src/components/LibraryView.tsx` | the grouping, the drag, the row actions |
| `src/components/PlaylistMenu.tsx`, `AddToPlaylist.tsx` | rename/delete, and getting tracks in |

## Verification links

| Claim | Test |
| --- | --- |
| A playlist keeps the order it was given, across a reorder | `db/mod.rs` · `a_playlist_keeps_the_order_it_was_given` |
| Deleting a track or a playlist leaves no orphans, and no files | `db/mod.rs` · `deleting_a_track_takes_it_out_of_every_playlist`, `deleting_a_playlist_takes_its_rows_and_leaves_the_tracks` |
| A path the library no longer holds is dropped, not fatal | `db/mod.rs` · `a_path_the_library_no_longer_holds_is_dropped_rather_than_fatal` |
| …and nothing else is | `db/mod.rs` · `a_playlist_write_forgives_a_missing_track_and_nothing_else` |
| A relocation carries the memberships, the edits, the fingerprints **and the waveforms** with it | `db/mod.rs` · `relocate_keeps_identity_including_edits_fingerprints_and_playlists` |
| A replacing conversion carries them too, instead of emptying the playlist | `db/mod.rs` · `a_replacing_conversion_carries_the_row_and_its_playlists`; `convert.e2e.test.tsx` · "keeps a converted track in the playlist it was in" |
| A row is numbered by the playlist, not by the filter | `playlists.test.ts` · "numbers a row by the playlist, not by what the filter left over", "counts a path the library no longer holds, and does not draw it" |
| A track in two playlists is two rows | `playlists.e2e.test.tsx` · "draws a track that is in two playlists as two rows" |
| A refused write puts the row back | `playlists.e2e.test.tsx` · "puts a row back where the database has it when a write fails" |
| Step and drag are the same move | `playlists.test.ts` · "agrees with the drag, which is the point of sharing its rule" |
| A move that cannot happen writes nothing | `playlists.test.ts` · "moves the last track down to nowhere, and the first up to nowhere" |
| The grouping shows the playlist's order and an Unsorted bucket | `playlists.test.ts` · `buildPlaylistGroups` cases |
| A playlist that would gain nothing is not offered | `playlists.e2e.test.tsx` · "will not offer a playlist the selection is already in", `playlists.test.ts` · `wouldAdd` |
| The selection reaches the backend in screen order | `playlists.e2e.test.tsx` · "puts a selection into a new playlist, in the order on screen" |
| The export goes where the dialog points, and nowhere on cancel | `playlists.e2e.test.tsx` · "exports the library where the save dialog points", "writes nothing when the save dialog is cancelled" |
| What we write, Rekordbox's own reader reads back | `export/rekordbox.rs` · `what_we_write_is_read_back_by_the_reference_reader` |
| Names that would break the document are escaped | `export/rekordbox.rs` · `names_that_would_break_the_document_are_escaped` |
| A pending edit is exported, and an unreadable one is not fatal | `export/rekordbox.rs` · `a_pending_edit_is_what_gets_exported`, `an_edit_that_cannot_be_read_leaves_the_row_alone`, `an_edit_for_a_track_outside_the_collection_changes_nothing` |
| The grid marker is on the track's clock | `audio/analysis.rs` · `the_beat_phase_is_reported_on_the_tracks_own_clock` |

## Keeping this honest

- **The export has never been imported into Rekordbox by a test**, and cannot
  be: the round trip above proves the document parses and carries the values,
  not that Rekordbox likes it. Before trusting a change here, import the file
  once by hand.
- **The beat grid is still not drawn under the waveform**, which **B3** was
  originally for. It is stored and exported now; the drawing is what is left.
- **A playlist cannot hold a track twice, and there are no folders of
  playlists.** The XML format supports both. Neither has been asked for.
- **A conversion that replaces its source keeps the memberships, but the
  merge case has only ever been tested against the database.** Converting onto
  a path the library already holds folds two rows into one
  (`db::replace_track`); no run against real files has produced that collision,
  because it needs a library that already has both the source and its output.
