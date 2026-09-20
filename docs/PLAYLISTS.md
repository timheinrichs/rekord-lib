# Playlists and the Rekordbox export

Where the library stops being this app's business. Everything else here
prepares files; this is the part that hands them over.

```
Library view                         Playlists view                 │
  selection → Add to playlist        drag / ↑ ↓ / − / rename        │
       │                                    │                       │
       └──────────────┬─────────────────────┘                       │
                      ▼                                             │
       lib/playlists.ts  (pure: what the new order is)              │
                      │                                             │
                      ▼  the whole list, never a diff               │
       playlist_set ── playlist_items(playlist_id, path, position)  │
                                                                    │
Library view ─────────────────── "Export for Rekordbox" ────────────┘
                                            │
                                            ▼
                              export::rekordbox::collection_xml
                                            │
                                            ▼
                                     rekordbox.xml
```

Two screens write to one pure core. Which one does what is not arbitrary: a
track gets *into* a playlist from the library, because what goes in is a
selection made there; everything about the *order* happens in the playlists
view. The export hangs off the library for the reason the backend gives — it
writes the whole collection, and the playlists ride along inside it.

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

`stepPlaylistItem` sharing the drag's rule is deliberate: moving *down* has to
aim one row further along than it looks, because the track is lifted out before
it is put back. Off by one there and a track swaps with itself, which reads as a
button that does nothing. A test asserts the two ways of reordering agree.

At the ends nothing happens, and it happens by returning *the same list* rather
than an identical copy — that identity is what lets the caller skip a write for
a button press that changes nothing.

## In the UI it is a view, not a grouping

Library · Playlists · Bandcamp. It was the fifth entry of the grouping switch
until 0.10.0, next to Flat, Album, Label and Folder — and the switch's own
comment had admitted the mismatch since it was written: *"unlike the three
before it this one does not fold the library into a different shape — it shows
an order the user made."* Those four are derived from the tags of the same
rows. A playlist is authored data with its own table, its own commands and its
own export.

**What it inherited there, and lost by leaving.**

- **A search and a filter.** They hide rows of a list whose entire content is
  its order, which is why the position a track held had to be read off the
  stored playlist rather than off the screen: a row showing "1" that was really
  the fifth entry would refuse to move up with four tracks above it.
- **Sort headers that were not inert.** This is the one worth being blunt
  about, because the old version of this document implied a guard that never
  existed. `SortableHeader` is always live and always writes `aria-sort`, and
  the playlist group builder was simply the one that never received the sort.
  So a click over a playlist told a screen reader the table had been sorted
  when it had not, re-faded the list and threw away its measured row heights.
  Nothing guards it now and nothing needs to: the case is gone with its host,
  and `SortableHeader` is local to `LibraryView`, so the new view cannot reach
  it even by accident.
- **An Unsorted bucket.** It existed because a *grouping* has to account for
  every row in the table it folds. A view has no such duty, and "what is in no
  playlist yet" is a question the library answers better, since it shows
  everything. The bucket is gone, and with it the argument that used to justify
  it here — *"a bucket that appears only sometimes is one nobody learns to look
  in"* — which was right about a grouping and does not carry.

**What the view is for: order.** A 270 px sidebar of playlists with their
counts, one open beside it, and four verbs — reorder, rename, remove, delete.
A row plays from its cover, the way a library row does, and the queue is the
playlist: what follows a track here is what follows it in the set.

A row carries the library's columns, minus four: `select`, because there is
nothing to select here; `Status`, because whether a file will play is a verdict
about the file and belongs where files are worked on; and `Added` and `Format`,
which are facts about the file rather than about its place in a set. The set is
**derived** from `COLUMNS` (`playlistColumns`) rather than written out a second
time, so a column added to the table turns up here too — and it honours the same
hidden-columns setting, because one switch should not mean two answers. The
position takes the chevron's column, which is where it sat as a grouping, and
the header names the columns without offering to sort them: the order is the
content, and a sort here would destroy the thing the view is for. There is no
selection and no bulk action: editing tags, converting and deleting files are
the library's job, where the filter and the columns are, and a second selection
model beside that one would be more chrome than this removed. It is also why a
drag here moves one row rather than a selection.

It gained one thing the table could not offer. There a row could only be
dropped *in front of* another, so appending by drag was impossible and the ↓
button was the only way to reach the end of a list. Here the half of a row the
pointer is in decides which gap is meant (`dropBefore`), so every gap is
reachable including the one after the last row, and a line is drawn in it.

**Reordering is done with pointer events, not HTML5 drag and drop**, and that
is not a preference. The window enables Tauri's own file drop so the library can
be filled by dragging files in (`onDragDropEvent`), and that handler takes drag
and drop at the *webview* level: `dragstart` still fires inside the page, and no
`dragover` and no `drop` are ever delivered to it. The table's playlist rows
carried HTML5 handlers from 0.9.0 and were therefore never draggable at all —
invisible to every test level, because only a person in the real app can find
it.

**The row moves as you carry it**, rather than a line being drawn where it
would go. The list reorders under the pointer and the numbers follow, so what
is dropped is exactly what was already on screen — there is nothing to indicate
and nothing to imagine. `gapIndexAt` says which gap the pointer is in and
`reorderAt` puts the row there; both are pure and read against the order **on
screen**, not the stored one, because the pointer can only mean something about
the rows it is actually over. The write is expressed against the stored list
once, at the end, by asking which path now follows the one that moved.

Two details are load-bearing. **The gesture is heard on the window, never
captured on the handle** — a capture sits inside the row, React moves that
row's node when the order changes, and moving it releases the capture. Worse,
it does so in one direction only: reconciliation moves the nodes that fall out
of order, which is the carried row going down and its neighbour going up, so a
captured drag worked upwards and stopped after one step downwards. And the list
is `select-none` while a row is carried, because a pointer drawn across table
cells selects their text and painted every row the drag crossed.

**A row is picked up by a handle**, not anywhere. That keeps the grab cursor
off the whole row, and it is what makes the gesture reachable without a
pointer: the handle is a button, and the arrow keys move the row while it has
focus. It replaced a pair of ↑ ↓ buttons that did the same job less well —
there is no keyboard equivalent of a drag, so the two could not simply be
dropped.

Two things happen at once and both are wanted. The list reorders underneath, so
the place the row will land is open and numbered; and **the row itself follows
the pointer**, as a raised copy portalled out of the table. Without the copy the
gesture has no weight — the row simply teleports — and without the reorder
beneath it there is nothing to aim at.

The copy draws the row's own cells — the same `cell()` over the same columns,
with the widths in a `colgroup` because a single-row table has no header to take
them from — so what is in hand is the row and not a summary of it.

A copy rather than the row, for three reasons that point the same way: a `<tr>`
in a `border-collapse: collapse` table does not reliably paint a shadow, so the
thing that has to look lifted cannot be the row; anything `fixed` inside a view
anchors to the document rather than the screen, because the view wrappers carry
a transform; and a plain element can use the raised tone, which a row cannot
without colliding with its own hover state. The row left behind is translucent.

**The rows that move slide there**, by FLIP: the new order is committed, each
row is pushed back to where it was with no transition and then released. It is
a layout effect, because the push-back has to land before the browser paints the
new order — in a normal effect the jump is visible first and the animation plays
after it. Nothing slides under `prefers-reduced-motion`, and that has to be
asked for explicitly here: a transform transition is not a CSS animation, so the
stylesheet's blanket `[class*="animate-"]` rule does not reach it.

**Getting tracks in stays in the library.** "Add to playlist" says what each
entry would do — `+3`, `+1 of 4`, or `already in` for one that holds the whole
selection, which is then not clickable. Said rather than hidden: it is also the
answer to "are these already in there?". It is a **dialog** since 0.10.0, not a
dropdown: the trigger sits among the selection's actions in the header, so it
moved as rows were picked, and a menu anchored to a control that moves had
already opened off the top of the window once. With the room a dialog has,
making a new playlist is an action of its own rather than the last row of the
list — and with no playlists yet it is the *only* action, so the dialog opens
on it.

It did not move to the playlists view, and the reason is worth keeping: the
dialog has a destination half — a list of playlists — and a subject half, which
is a selection made in the library table. Only the second is expensive, and it
cannot leave the table it is made in.

**The entries the loaded library has no row for.** A playlist that says "12
tracks" over 9 rows is one nobody can make sense of, so `playlistRows` keeps
them, by file name. What such an entry is, precisely, is worth being exact
about, because the obvious answer is wrong: **not a deleted file.**
`playlist_items.path` references `tracks(path)` `ON DELETE CASCADE`, so a track
that leaves the library takes its memberships with it, and `set_playlist_paths`
drops a path the library does not hold rather than storing one. What remains is
the case the two queries disagree on — `all_playlist_paths` reads every
membership, `load_tracks` reads one `library_dir` — a track in **another
library folder**, which is what switching folders without relocating leaves
behind. Those files are intact, so the row says where they are instead of
calling them missing, and removing one is offered as what it is: taking it out
of the playlist.

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
`<TEMPO>` marker where a beat grid exists — the hand-placed one where there is
one, the detected one otherwise.

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

**One marker, and its bar position is asserted unless somebody set it.** Our
detector produces one tempo per track, so a grid is a period and a phase
(**B3**); `Metro="4/4"` is what the format wants and is all the app knows. The
phase is stored on the *track's* clock — the detector counts from the start of
its 120 s excerpt, which usually begins 30 s in, so the raw number would put
every beat half a minute early.

`Battito` used to be the literal `1` on every track, because the bar position is
exactly what the detector does not produce. A grid placed by hand carries one
now, and the export writes it; a detected grid still says 1 without knowing it.
The overlay works the way the metadata one above does — `grid_edits` is read
beside the tracks and resolved in `track_xml`, so `tracks.beat_offset_secs`
keeps meaning what the detector found. See [PLAYBACK.md](PLAYBACK.md), and note
that no export with a bar position other than 1 has been through a real
Rekordbox yet ([CDJ_TEST_MATRIX.md](CDJ_TEST_MATRIX.md)).

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
| `src/components/LibraryView.tsx` | the selection a playlist is filled from, and the export |
| `src/components/AddToPlaylistDialog.tsx` | getting tracks in, and what each playlist would gain |
| `src/components/PlaylistsView.tsx` · with `playlists.ts` · `playlistRows` | the sidebar, the open playlist, the drag and the row actions — move up, move down, remove; **no delete**, because "−" and a trash can one step apart differ by an icon and mean losing a place in a set versus losing the file, and deleting a file is the library's job |

## Verification links

| Claim | Test |
| --- | --- |
| A playlist keeps the order it was given, across a reorder | `db/mod.rs` · `a_playlist_keeps_the_order_it_was_given` |
| Deleting a track or a playlist leaves no orphans, and no files | `db/mod.rs` · `deleting_a_track_takes_it_out_of_every_playlist`, `deleting_a_playlist_takes_its_rows_and_leaves_the_tracks` |
| A path the library no longer holds is dropped, not fatal | `db/mod.rs` · `a_path_the_library_no_longer_holds_is_dropped_rather_than_fatal` |
| …and nothing else is | `db/mod.rs` · `a_playlist_write_forgives_a_missing_track_and_nothing_else` |
| A relocation carries the memberships, the edits, the fingerprints **and the waveforms** with it | `db/mod.rs` · `relocate_keeps_identity_including_edits_fingerprints_and_playlists` |
| A replacing conversion carries them too, instead of emptying the playlist | `db/mod.rs` · `a_replacing_conversion_carries_the_row_and_its_playlists`; `convert.e2e.test.tsx` · "keeps a converted track in the playlist it was in" |
| Every stored entry is listed, numbered by the playlist | `playlists.test.ts` · `playlistRows` cases; `PlaylistsView.test.tsx` · "shows the stored order, numbered" |
| A track can be in two playlists, with its own place in each | `playlists.e2e.test.tsx` · "keeps a track in two playlists, each with its own place" |
| A playlist row removes, and cannot delete the file | `playlists.e2e.test.tsx` · "takes a track out of the playlist, but not off the disk" |
| The view shows the whole stored playlist and writes the order it shows | `playlists.e2e.test.tsx` · "shows the whole stored playlist and writes the order it shows" |
| The row moves as it is carried, and what is written is what was shown | `PlaylistsView.test.tsx` · "moves the row itself as the pointer travels, and writes what is shown", "carries a row to the end of the list" |
| A copy follows the pointer, and not before the press has travelled | `PlaylistsView.test.tsx` · "carries a copy of the row under the pointer" |
| A row can be carried several places, in either direction | `PlaylistsView.test.tsx` · "carries a row down past more than one neighbour", "carries a row up past more than one neighbour" |
| The gesture survives the row it began on being moved in the DOM | `PlaylistsView.test.tsx` · "keeps hearing the pointer after the row it began on has moved" |
| Escape abandons a drag and leaves the order alone | `PlaylistsView.test.tsx` · "abandons the drag on Escape, leaving the order alone" |
| An abandoned drag leaves the stored order alone | `PlaylistsView.test.tsx` · "puts the row back when the gesture is cancelled" |
| A press that never travelled moves nothing, and only the handle picks a row up | `PlaylistsView.test.tsx` · "does not move anything when the press never travelled", "does not arm a drag from the row's other buttons" |
| The handle reorders from the keyboard, and not past the ends | `PlaylistsView.test.tsx` · "reorders from the keyboard, and not past the ends" |
| Nothing is selected while a row is carried | `PlaylistsView.test.tsx` · "marks no text while a row is being carried" |
| Playing from a row queues the playlist, in its order | `playlists.e2e.test.tsx` · "plays a track from the playlist, queueing the playlist" |
| Which gap a pointer means, including the one past the last row | `playlists.test.ts` · `gapIndexAt` cases |
| The row lands where it looks like it will, dragged either way | `playlists.test.ts` · `reorderAt` cases |
| The view's columns are the table's minus four, and follow the same hidden set | `columns.test.ts` · `playlistColumns` cases |
| Switching playlists drops an armed delete | `PlaylistsView.test.tsx` · "drops an armed delete when another playlist is opened" |
| The picker says `+N`, `+N of M` and `already in`, and refuses the last | `AddToPlaylistDialog.test.tsx` · "says what each playlist would gain…"; `playlists.e2e.test.tsx` · "will not offer a playlist the selection is already in" |
| It commits once and leaves, and Escape cancels the field before the dialog | `AddToPlaylistDialog.test.tsx` · "commits once and leaves", "gives Escape to the field before the dialog" |
| It lands in the middle of a real window, wherever its trigger is | `e2e/menus.spec.ts` · "centres the playlist picker, and covers the window behind it" |
| Putting tracks in says so, once, in the backend's words | `toasts.e2e.test.tsx` · "says what was added, in the backend's own words"; `commands.rs` · `a_playlist_write_reports_membership_and_not_order` |
| The ends of the list are disabled, and an entry from another library folder stays visible | `PlaylistsView.test.tsx` · "disables the moves that would go nowhere"; `playlists.test.ts` · `playlistRows` cases |
| The name field shows the stored name, not a rename that did not happen | `PlaylistsView.test.tsx` · "treats an emptied field as a cancelled edit", "renames on Enter and leaves the name alone on Escape" |
| A refused write puts the row back | `playlists.e2e.test.tsx` · "puts a row back where the database has it when a write fails" |
| Step and drag are the same move | `playlists.test.ts` · "agrees with the drag, which is the point of sharing its rule" |
| A move that cannot happen writes nothing | `playlists.test.ts` · "moves the last track down to nowhere, and the first up to nowhere" |
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
