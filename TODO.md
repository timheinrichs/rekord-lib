# TODO — deferred and declined

Item **F7** from [docs/FUTURE_CONSIDERATIONS.md](docs/FUTURE_CONSIDERATIONS.md):
a place for things that were considered and consciously **not** done, so the
same idea does not get re-litigated every few months.

**What belongs here and what does not.**
[docs/FUTURE_CONSIDERATIONS.md](docs/FUTURE_CONSIDERATIONS.md) is the roadmap —
things we *could* do, with a size and a reason. This file is the other half:
work that was split off, measured and rejected, or deliberately left undone.
Every entry says what it is, why not, and **what would change that**. An entry
leaves this file when it is done or when the condition it named has arrived.

Follow-up ids (`C1a`, `C2a`, …) are the ones the roadmap assigned when the
parent item shipped without them.

---

## Measured and rejected

### B4 · Analysing several windows per track

**What** — three 120 s excerpts spread over the track instead of the single one
at 0:30, reconciled by clustering: the largest group of agreeing windows wins.

**Why not** — it was built, measured and removed. It changed the outcome by
**one track out of 2175** at 2.9× the decode cost, and the tier it existed for
did not move at all: the 568 tracks whose Rekordbox grid wanders scored 73.1 %
within ±2 BPM either way. Where a track has one tempo, one window finds it;
where it has none, no single number is right. Numbers in
[docs/DSP_BENCHMARK.md](docs/DSP_BENCHMARK.md).

**What would change that** — the one real effect was on the *confidence*, not
the tempo: agreement between windows separates correct from wrong answers
noticeably better than a single peak does (mean gap 0.16 → 0.25). If the write
gate in `audio/bpm.rs` ever needs to be sharper, this is where to look — and
then it is a confidence mechanism, not a tempo mechanism.

### Log-compressing the chroma magnitudes

**What** — the standard second step in key detection, after per-frame
normalisation.

**Why not** — it broke every synthetic test case, and there was no measurement
that justified it over that objection. Per-frame normalisation, the other
standard step, *was* adopted and was worth 27 tracks.

**What would change that** — a measurement on the reference set that shows a
gain, plus an explanation for the synthetic cases.

### Narrowing the default tempo range

**What** — defaulting to 70–180 BPM instead of 60–200, the way comparable tools
do.

**Why not** — measured, and it does not help. 70–180 is indistinguishable from
the wide range (+8 tracks out of 2175, p = 0.45), and 90–180 is significantly
*worse* while leaving 22 tracks with no tempo at all. The presets exist as a
setting (**B5**) for a library that really does sit in one genre.

**What would change that** — a single-genre collection to measure on. The
reference collection spans 70–185 BPM and cannot test the case.

---

## Split off when the parent shipped

### C1a · The scan's BPM pass has no undo record

**What** — the BPM pass writes a tempo tag into every file it detects one for,
and nothing records what was there before.

**Why not** — it is additive by default: it only fills an empty BPM, so there is
usually nothing to take back. And undoing it through `write_metadata` would
rewrite *every* tag in the file, which is a heavier operation than the write
being undone.

**What would change that** — `force` re-detection, which does overwrite an
existing value. It needs its own narrow undo path next to `write_bpm`, not a
detour through the full write. See [docs/METADATA.md](docs/METADATA.md).

### C1b · A conversion is not machine-reversible

**What** — after a conversion the original is in the trash and the output is on
disk, and nothing ties the two together.

**Why not** — the reversible part is already true (the source goes to the trash,
never `remove_file`); what is missing is the record that would let the app undo
it for you.

**What would change that** — a user reporting a conversion they did not mean.
The pieces exist: `ConvertResult` names both paths, and the undo history is
already a database table.

### C2a · Dismissed duplicate groups do not survive a relocate

**What** — a dismissal is keyed by the smallest path in the group, so
re-pointing the library at a moved folder leaves the dismissals aimed at the old
paths and the groups come back once.

**Why not** — the rows themselves survive; only the "waved off" decision does
not, and it comes back exactly once. Rewriting dismissal keys inside
`library_relocate` is more moving parts than the symptom justifies.

**What would change that** — a group id that is not a path. See
[docs/DUPLICATES.md](docs/DUPLICATES.md).

### A1a · A replacing conversion drops the track out of its playlists

**What** — convert with "replace source" and the original is trashed, the row is
pruned by the next sweep, and `playlist_items` cascades away with it. The
converted file arrives under a new path as a new row, in no playlist. So
"fix the sample rate on this whole set" empties the set it was run on.

**Why not now** — the fix is not a line, it is a decision: whether a replacing
conversion is a *move* of the track (keep the row, rewrite its path, let the
next scan re-probe it, carry the memberships along the way `relocate_tracks`
does) or a delete-and-add that has to copy the memberships across afterwards.
The first is the more coherent model and touches the fingerprint cache, which is
keyed by path and would no longer describe the audio behind it. Not something to
decide inside a release.

**What would change that** — the first user who converts a playlist. Until then,
the workaround is to convert first and build the playlist afterwards.

### A2a · The export writes tags, not pending edits

**What** — `export_rekordbox_xml` reads the rows, and the `edits` table is not
consulted. A user who fixes artists in the metadata editor without applying them
sees the new values in the table and the old ones in `rekordbox.xml`.

**Why not now** — the backend deliberately never interprets the frontend's
`TrackEdit` JSON (`db::load_edits` returns it opaque), so overlaying the edits in
the export would break that boundary for one caller. The other end — refusing or
warning before the export — is a UI question about an amount of state the export
button does not have.

**What would change that** — a typed edit payload the backend can read, which
several other items would also use.

### The beat grid is stored and exported, but not drawn

**What** — `tracks.beat_offset_secs` plus the tempo is a full grid, and A2 writes
it into the Rekordbox export as a `TEMPO` marker. Nothing draws it under the
waveform in the app, which is what **B3** was originally for and what
`COMPARISON.md` claimed for two releases before the claim was corrected.

**Why not act** — the value only started being stored with A2, and the waveform
row is 112 px wide for a whole track: at that scale the beats of a 128 BPM track
are under a pixel apart, so "draw the grid" means deciding what to draw first.
The player bar's larger waveform is where it would actually be legible.

**What would change that** — a zoomed waveform, or a decision that the row
should show the first beat alone rather than a grid.

### The legacy `library` key in `rekord-lib.json`

**What** — the pre-SQLite library, imported once by `db::migrate` and then left
in place.

**Why not** — deliberately kept so a downgrade still finds its data.

**What would change that** — it may be dropped one release after 0.4.8. Nothing
reads it any more.

---

## Recorded because nobody else would notice

Found while writing the documentation, and not worth a change on their own.

### Four commands with no caller

`cancel_scan`, `cancel_dedupe`, `dedupe_status` and `dedupe_result` are
registered and wrapped in `src/lib/api.ts`, and no view calls them: the scan
button is pause/resume only. `start_scan(force = true)` — the deep re-probe that
bypasses the identity cache — is in the same position.

**Why not act** — a cancel button is a design decision, not a wiring gap, and
pause covers the case it would serve. Deleting the commands would be the wrong
move too; they are the reattach-and-abort surface a future control needs.

**What would change that** — a user asking to abort a run rather than hold it.

### Two mirrors that can drift

`norm_text` and `norm_album` exist in both `src-tauri/src/audio/dedupe.rs` and
`src/lib/dupAlbums.ts`, with no shared test asserting they agree. The metadata
tier of the duplicate search is likewise verified through a `meta_matches`
*mirror* of logic that is inlined in `find_duplicates`, so the test can pass
while the real code changes.

**What would change that** — a fixture list of input/output pairs both sides
assert against would cost little; extracting the tier into a callable function
would fix the second one properly.

### `STAGE_WAVEFORM` has no counterpart in `src/types.ts`

The stage labels are mirrored by hand, and this one was not carried over. It is
cosmetic today, and it is the exact shape that drift between the two sides
takes.

### `AUDIO_EXTENSIONS` exists twice

Once in `src-tauri/src/commands.rs` with a fixed array length, once in
`src/lib/api.ts` as a plain array. The Rust side fails loudly when the two get
out of step; the TypeScript side does not.

### `src/lib/dupAlbums.ts` is invisible to `grep`

It uses a literal NUL character as the separator in its folder-pair keys, which
makes `grep`, `file` and GitHub's diff view treat the file as binary. Search it
with `grep -a`. A printable separator that cannot occur in a path would remove
the trap; nothing depends on it being NUL.

### Four commands are `serde_json::Value` on one side and typed on the other

`edits_load`, `edit_set`, `duplicates_load` and `duplicates_save` are opaque
JSON in Rust while TypeScript asserts `TrackEdit` and `DuplicateGroup`. That is
deliberate — the shape belongs to the UI — but it is unchecked on both sides.

---

## Test coverage that is thinner than it looks

Collected while writing the *Verification links* sections, where a claim with no
test behind it has nowhere to hide.

**G1 has shipped and this table is what it left.** Two rows are gone:
`convert_tracks` is now driven end to end — a real conversion renamed over its
source, checked with ffprobe (`e2e/convert.spec.ts`) — and
`DuplicatesModal.tsx` has a flow test that pins which paths the panel offers to
delete (`src/e2e/duplicates.e2e.test.tsx`). What remains is narrower than it was,
because each of these is now *exercised* by a passing suite without being
*asserted* anywhere.

| Untested | Why it matters | What G1 changed |
| --- | --- | --- |
| `metadata::write::finalize` | end to end. Only `apply_cover` and the field mapping are tested, and this is the code that rewrites tags | runs on every metadata flow test and on the e2e scan, so a panic would be caught — a wrong tag would not |
| ~~`metadata/artwork.rs`~~ | *closed with C8.* `process_cover` and `already_cdj_shaped` are tested against generated images, including the round trip that says the encoder's own output is not re-encoded, and `write.rs` checks the restored bytes against a real file | — |
| `audio::dedupe::find_duplicates` | no test; it needs an `AppHandle` | the e2e run reaches it with real audio, but nothing asserts the tiers, so the `meta_matches` mirror can still drift |
| `convert_file`'s three cleanup branches | the failure paths that decide whether a half-written file is left behind | still unreachable: they need ffmpeg to fail mid-run, which no fixture provokes |

**Why not act** — each of these needs the failure *provoked*, not just the path
walked. A corrupt file that ffprobe accepts and ffmpeg chokes on would cover the
cleanup branches. (The cover row is struck through rather than removed because
the table is G1's record of what it left behind; what closed it was C8, which
needed those bytes for its own reasons.)

**What would change that** — a fixture built to fail. `dev-library.py` generates
files that work, on purpose; a second, smaller set built to break in a specific
way is the missing piece, and it is small.

### The e2e toolchain costs dependency surface

**What** — `@wdio/*` plus its transitive tree adds roughly 380 packages to
`node_modules` and takes `npm audit` from 5 findings to 14 (13 high). The roots
are `extract-zip` (via `@puppeteer/browsers`, which the embedded driver never
runs), `serialize-javascript` (via mocha), `deepmerge-ts` and `undici`.

**Why not act** — all of it is `devDependencies`. `npm audit --omit=dev` reports
zero, and nothing here enters the bundle, which is what the
*Distribution, robustness & security* rules in `CLAUDE.md` are about. The
alternative was dropping the whole second test layer, which would have given up
the only thing that can say the shipped app works.

**The decision E4 needed has been made.** The scheduled `Audit` workflow runs
`npm audit --omit=dev --audit-level=high`, so these 13 do not fail a job: they
are `devDependencies` and the rule they would be measured against is about what
ships in the bundle. The entry stays because the surface does — the audit simply
no longer has an open question attached to it.

**What would change that** — an advisory that turns out to be reachable from a
test run rather than only from a browser download the embedded driver never
performs; or `@wdio/*` becoming a runtime dependency, which it must not.

---

## Deliberately not adopted

Kept in
[docs/FUTURE_CONSIDERATIONS.md](docs/FUTURE_CONSIDERATIONS.md#deliberately-not-adopted)
rather than repeated here, because the arguments should exist in one place:
downloading an analysis engine at runtime, monolithic modules, shipping without
CI, unsigned updates, and a vanilla-JS frontend.

---

## Keeping this honest

- An entry needs the **condition** that would revive it. "Not now" without a
  trigger is a note, not a decision, and it is what makes a list like this rot.
- When an entry is done, delete it here and say so in `CHANGELOG.md` — the
  changelog is the record of what happened, this file is only the record of what
  deliberately did not.
- A roadmap item that ships *without* part of itself creates an entry here in
  the same commit, with an id, the way `C1a` and `C2a` were created — and it
  leaves again when that part ships, the way `C5a` did.
