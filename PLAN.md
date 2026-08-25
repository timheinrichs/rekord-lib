# PLAN — 0.8.1

Two gaps that 0.8.0 shipped with, both recorded in `TODO.md` when the playlist
release went out: **A1a** (a replacing conversion drops the track out of its
playlists) and **A2a** (the export writes tags, not pending edits). Neither is a
new capability — both are cases where the app already promised something and
then quietly did not deliver it — so this is a **PATCH**: `0.8.0` → `0.8.1`.

---

## A1a · A replacing conversion is a move, not a delete-and-add

**What happens today.** `convert_tracks` never touches the database. Convert
with "replace source" and the original goes to the trash, the next sweep prunes
its row, and `playlist_items` cascades away with it. The converted file arrives
under a new path as a new row, in no playlist. "Fix the sample rate on this
whole set" empties the set it was run on.

**The decision.** `TODO.md` named two models — a *move* of the track, or a
delete-and-add that copies the memberships across afterwards. **Move.** It is
the more coherent one: the file the user is looking at is the same piece of
music at a new path, which is exactly what `relocate_tracks` already models for
a moved folder. Delete-and-add would need the copy to happen after the new row
exists, which is in the frontend, which is where playlist state must *not* live.

**Why the fingerprint objection does not survive contact.** The entry worried
that the fingerprint cache is keyed by path and would no longer describe the
audio behind it. It is keyed by path *and* `mtime_ms + size_bytes`, and the
converted file matches neither — so a carried-over row could never be read back.
The move therefore **drops** the `fingerprints` and `waveforms` rows rather than
carrying them: they describe a file that no longer exists, and re-deriving them
is what the next scan is for.

**And the edit is dropped, not carried.** This is the difference from
`relocate_tracks`, which carries edits because nothing was applied. A conversion
runs `write::finalize` over the output — the pending edit *has been written into
the file*. Carrying it would make it reappear as still-pending on the new path.
(The frontend already clears it for the old path; after this, that call is
belt-and-braces rather than the only thing doing it.)

**Where it goes.**

- `db::replace_track(conn, old_path, new_path) -> DbResult<bool>` next to
  `relocate_tracks`, with the same `PRAGMA defer_foreign_keys = ON` transaction
  and the same rule that **every child table has to be listed**, or the commit
  fails as a bare foreign-key error.
  - `tracks`: path + `file_name` rewritten. Where a row for `new_path` already
    exists (converting `a.wav` onto an `a.aiff` the library already knows), the
    memberships move onto it and the old row is deleted — a merge, not a skip,
    because unlike a relocation the old file is genuinely gone.
  - `playlist_items`: `UPDATE OR IGNORE`, because `(playlist_id, path)` is the
    primary key and the target may already be in that playlist. Leftovers are
    deleted with the old row's cascade.
  - `edits`, `fingerprints`, `waveforms`: deleted for the old path, per above.
- Called from `convert_tracks`, immediately after the source goes to the trash
  and only then — so it runs before the frontend's `analyzeFiles` upserts the
  output path, and that upsert lands on the moved row instead of creating a
  second one. The database guard is scoped and released before anything logs,
  the way the export deadlock taught us.

**Tests.** `db::mod` unit tests: memberships carried; position preserved;
edit/fingerprint/waveform dropped; the target-path-taken merge; the same track
already in the target playlist (the PK conflict) — and a track in two playlists,
which is the case 0.8.0 had to fix once already. A flow test in
`src/e2e/convert.e2e.test.tsx` or `playlists.e2e.test.tsx` that converts a track
out of a playlist and asserts the playlist still holds it, because a unit test
on the db function cannot see whether the command calls it.

---

## A2a · The export overlays the pending edits

**What happens today.** `export_rekordbox_xml` reads the rows and never looks at
the `edits` table. Fix the artists in the metadata editor without applying them
and the table shows the new values while `rekordbox.xml` carries the old ones —
silently, which is the worst version of it.

**The decision.** `TODO.md` framed this as "the backend deliberately never
interprets the frontend's `TrackEdit` JSON, and breaking that boundary for one
caller is the cost". The boundary survives intact: **`db::load_edits` stays
opaque `serde_json::Value`, and the export does the interpreting** — for itself,
leniently, in its own module. Nothing else in the backend learns the shape.

It is also less new typing than it sounds. The payload is
`{ metadata: TrackMetadata, cover: CoverInput }` and `models::TrackMetadata`
already *is* the Rust mirror of the TS `TrackMetadata`, field for field. So the
export deserializes into `struct EditOverlay { metadata: TrackMetadata }` and
ignores everything else in the object, `cover` included — there is no artwork in
this format to write anyway.

**Lenient on purpose.** A payload that does not deserialize is not an error and
does not fail the export: that track exports with the tags from its row, which
is exactly today's behaviour. An overlay that cannot be read must not be able to
take an export down.

**Whole-object, not per-field.** `metaOf` in `src/lib/grouping.ts` is
`edits[t.id]?.metadata ?? t.metadata` — the edit replaces the metadata, it does
not merge into it. The export does the same thing, so the xml says what the
table says, which is the entire point of the fix. (`edits` is keyed by path and
`TrackAnalysis.id` *is* the path — `db::mod.rs:225` — so the two maps line up
with no translation.)

**One consequence worth stating:** the `<TEMPO>` marker reads `md.bpm`, so an
edited tempo moves the grid's period while keeping the detected phase. That is
the right answer — a user who corrected the tempo corrected the grid — and it
gets a line in `docs/CONVERSION.md`'s neighbour, `docs/METADATA.md`.

**Where it goes.** `collection_xml` grows an `edits: &HashMap<String,
TrackMetadata>` parameter and stays pure; the command builds that map from
`db::load_edits` inside the same scoped guard that already reads the tracks and
the playlists. `track_xml` resolves `edits.get(&t.path).unwrap_or(&t.metadata)`
once, at the top, where `md` is bound today.

**Tests.** In `export::rekordbox`: an edit overrides the row's artist and title;
an unparseable payload falls back to the row; an edit for a path that is not in
the collection changes nothing; the round trip through
`scripts/rekordbox-reference.py` still holds. A flow test that seeds an edit and
asserts the written xml carries the edited value.

---

## Checks and documentation

`npx tsc --noEmit`, `cargo check --tests` at zero warnings, `npm test`,
`cargo test`, then `/code-review` before the commits. `npm run tauri dev` to
convert a track out of a playlist and export with a pending edit, because
neither unit tests nor flow tests can say the wiring is right.

Documentation, per the release rules: **`TODO.md`** loses both entries — that is
what this release is for. **`docs/CONVERSION.md`** and **`docs/PLAYLISTS.md`**
gain the move, **`docs/METADATA.md`** the overlay and the tempo consequence,
**`docs/COMPARISON.md`** loses a "we do not" if one of these was listed there,
and **`docs/FUTURE_CONSIDERATIONS.md`** gets the *What shipped* paragraphs under
A1 and A2. `docs/COMMANDS.md` only if a signature actually moves — no new
command is planned. `CHANGELOG.md` gets a `Fixed` section; ordinary severity.

The version bump itself waits for the maintainer's go.
