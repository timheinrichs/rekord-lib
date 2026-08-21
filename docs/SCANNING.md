# Scanning and cache invalidation

Item **F1** from [FUTURE_CONSIDERATIONS.md](FUTURE_CONSIDERATIONS.md): what a
scan actually does, and — the harder half — when the app is allowed to trust
what it already knows. Almost everything surprising about the library view comes
from one of those two questions.

## How it works

A scan is a background job, not a request. `start_scan` returns immediately,
runs as a single-flight task and reports everything through events; the database
is written from Rust as the job goes, so closing the window mid-run loses
nothing but the rest of the run.

```
start_scan  (single-flight; a second call while one runs returns false)
 │  generation += 1
 │  full = paths.is_none() && the library root could actually be listed
 │
 ├─ Phase 1 · "Analyzing"           PROBE_CONCURRENCY files at a time
 │    stat the file  →  cache hit? reuse the row, untouched
 │                      miss?      ffprobe + compat::evaluate + read tags
 │    every SCAN_BATCH results: persist, emit scan://tracks
 │    a file that cannot be probed: record_skip → scan://skipped, run continues
 │    full sweep, not cancelled → prune rows whose file is gone
 │
 ├─ Phase 2 · "Detecting BPM & key" / "Drawing waveforms"   budgeted width
 │    one decode per file answers tempo, key, beat phase and waveform
 │    tempo above MIN_WRITE_CONFIDENCE is written into the file's tag
 │    re-stat, store waveform, emit scan://patch per file
 │
 └─ Phase 3 · "Finding duplicates"      only after a full sweep or a real change
      see DUPLICATES.md
 always: scan://progress (running = false), then scan://done
```

The frontend never polls. `LibraryView` merges `scan://tracks` and
`scan://patch` into its list — a batch carries both freshly probed rows and rows
reused from the database, and names the fresh ones in `fresh`, which is what
lets a per-file cache tell "this changed" from "this was already known" — and a reloaded window reattaches to a run in
progress through `scan_status`. Progress, stage and the pause flag all travel in
`scan://progress`, which is why the scan button survives a reload mid-scan.

The **incremental sync** runs on start and whenever the watched folder changes,
and it is only a diff: it lists the folder, compares it against the library,
forgets rows whose file is gone, and hands genuinely new paths to the job as a
targeted run. It used to hand them to `analyze_files` instead — one blocking
command with no progress and no pause, which is why the first population of a
library could not be held. That was **C5a**, and it is closed.

One entry point still does not go through the job: files dragged in from outside
the library go straight to `analyze_files`, because they are converted or copied
individually and there is no folder to sweep.

## Deep technical details

### What invalidates what

Three caches, three different invalidation contracts. This is the part that has
to stay honest, and `CLAUDE.md` requires every new cache to state its own.

| Cache | Valid while |
| --- | --- |
| A `tracks` row | the file's mtime and size still match (`db::needs_reanalysis`) **and** the app version has not changed since the row was written |
| A `fingerprints` row | mtime, size and `fingerprint::ALGO_VERSION` match |
| A `waveforms` row | mtime, size and `waveform::ALGO_VERSION` match |

**A version bump nulls the identity, it does not delete the row.**
`db::invalidate_on_version_change` sets `mtime_ms` and `size_bytes` to `NULL`
where they were set, which marks every file for exactly one re-probe while the
library stays on screen. Deleting rows instead would empty the app on every
update and take the identity that edits hang off with it.

**Fingerprints and waveforms deliberately survive that bump.** They depend on
the audio and on their own `ALGO_VERSION`, not on the app version — so an update
costs one cheap re-probe per file and no decodes at all. Bump the matching
`ALGO_VERSION` when the decode window, the sample rate or the algorithm's
configuration changes; that is the only thing that throws those away.

**A database with no recorded version invalidates nothing.** It was created by
the version now asking — a fresh install, or the one-time JSON import — so its
rows are current, and invalidating them would discard identities that were just
stat'ed.

**Derived verdicts are recomputed, never stored.** `compat` and
`metadata_incomplete` come back out of `compat::evaluate` and
`TrackMetadata::is_complete` on every read (`db::row_to_track`), so a rule
change takes effect at once instead of leaving thousands of stale verdicts in
rows. The schema says so where the columns would otherwise be.

### The stat order is load-bearing, twice

The filesystem identity is taken **before** the probe, not after. A file that
changes while it is being probed then still looks stale next time, instead of
having a half-stale analysis cached under its new state.

And it is taken **again after the BPM pass has written the tag**. Writing a tag
changes mtime and size: keep the identity from before the write and every file
the pass touched looks modified forever, re-probed on every sweep, its freshly
stored waveform thrown away for carrying the old stamp.

### An unreadable folder is not an empty folder

`is_full_sweep` is `paths.is_none() && library_root_available(dir)`. Without the
second half, a renamed or unmounted library folder walks to zero files, the
sweep concludes the whole library was deleted, and the prune takes the rows,
their fingerprints and the identity every pending edit hangs off.

The frontend holds the mirror rule: `diffAudioFiles` takes `null` for "could not
look" and an empty array for "looked, found nothing". Both paths had to be fixed
— only running the app found the second one — which is why the rule now lives in
a pure function with tests on both cases.

### Pause is not cancel

`paused` is checked by `await_resume` immediately before the next unit of work
is taken, in all three phases, on a 150 ms poll. Whatever is already in flight
finishes and is persisted, so a pause never costs a file its analysis. `cancel`
ends the run instead; both flags are read in the same loop, so cancelling a
paused run works, and `cancel_scan` clears `paused` explicitly.

`set_scan_paused` on a run that is not running clears the flag rather than
setting it — a stale click cannot hold the *next* run hostage. There is no
separate pause button: the scan button shows the run, and on hover shows what a
click would do.

### What a patch may and may not say

`scan://patch` carries only what the analysis produced. **A `null` field means
unchanged, not "not detected"** — the pass never clears a value it failed to
find, so `applyPatch` writes the named fields and leaves the rest of the row
alone. A patch for a path the list does not know is dropped, which is also the
app's whole defence against results from a superseded run: `generation` is
stamped on every event and checked by nobody.

**A waveform-only result changes no column of the row.** It is worth emitting —
`waveform: true` tells the row to re-ask for its drawing — and not worth
persisting to `tracks`, so it takes the short path and does not re-derive the
list.

The tempo is rounded to two decimals in `patch_of`, before it reaches anything.
The `f32` detector widened to `f64` otherwise produced `127.5999984741211` in
the database and the editor while the file said `127.60`.

Patches are then collected in a 250 ms window in the frontend
(`lib/scanPatchBatch.ts`) before they reach the list, because the table has no
memoised rows: one `setTracks` rebuilds every row, re-derives filter, sort and
grouping, and re-measures every height. Four updates a second read as "filling
in" whether the analysis produces two files a second or twenty.

### How wide the passes run

`workers::budget` takes the smaller of two budgets — cores minus two, and how
many workers of a given size fit in the memory that is actually free — and
clamps it into `1..=cap`, where `cap` is the value the pass was measured at. It
can only ever *lower* a measured width, never raise it. It is asked at the start
of each pass, because free memory changes while the app is open. `REKORD_JOBS`
overrides both terms, clamped so a typo cannot fork-bomb the machine.

`PROBE_CONCURRENCY` sits deliberately outside that budget: ffprobe reads headers
rather than audio, holds nothing worth budgeting, and the pass is bound by
process startup rather than by cores.

### Migrations

`db::migrate` runs before anything reads: transforming steps first, then the
idempotent `CREATE TABLE IF NOT EXISTS` block. Two constraints that are easy to
trip over — a new column has to go at the **end** of the schema, because
`ALTER TABLE ADD COLUMN` can only append and a test holds a migrated database to
the same column order as a fresh one; and a step that has to rebuild a table
must turn foreign keys off for the duration, or dropping `tracks` cascades every
cached fingerprint away with it.

The startup path never refuses to launch. A database that cannot be opened, an
import that fails and an invalidation that fails are all logged and carried past
— an empty library the next scan rebuilds beats an app that does not start.

## Implementation anchors

| Where | What |
| --- | --- |
| `src-tauri/src/commands.rs` · `start_scan` | the whole three-phase job, single-flight, `generation`, `full` |
| … · `detect_bpm_pass`, `analysis_stage` | phase 2, and the stage label derived from what tracks are missing |
| … · `analyze_path`, `record_skip` | one file's analysis; the skip that keeps the run going |
| … · `patch_of`, `apply_patch`, `TrackPatch::changes_row` | what a patch carries and what it is allowed to mean |
| … · `flush_scan_batch`, `persist_tracks`, `retain_scanned_tracks` | incremental persistence and the prune |
| … · `is_full_sweep`, `library_root_available`, `dedupe_after_scan` | when a sweep counts as full and when phase 3 runs |
| … · `await_resume`, `set_scan_paused`, `cancel_scan`, `scan_status` | pause, cancel, reattach |
| … · constants | `PROBE_CONCURRENCY`, `SCAN_BATCH`, `BPM_CONCURRENCY`, `BPM_WORKER_BYTES`, `MIN_WRITE_CONFIDENCE` (with its measured trade-off table) |
| `src-tauri/src/jobs.rs` | `ScanState`, `DedupeState`, `WatchState` — the flags and counters |
| `src-tauri/src/audio/workers.rs` · `budget`, `Host::detect` | the width of a pass; `REKORD_JOBS` |
| `src-tauri/src/audio/analysis.rs` · `analyze`, `Wanted`, `excerpt_of` | one decode, four answers |
| `src-tauri/src/audio/decode.rs` · `mono_pcm` | the decode every cached artifact is built on |
| `src-tauri/src/db/mod.rs` · `fs_identity`, `needs_reanalysis` | the identity contract |
| … · `invalidate_on_version_change` | the version rule, and why fingerprints survive it |
| … · `row_to_track`, `load_track_cache`, `upsert_tracks`, `retain_tracks` | reading, recomputing, writing, pruning |
| … · `waveforms_load`, `waveform_save`, `fingerprints_load`, `fingerprint_put` | the two content-keyed caches |
| `src-tauri/src/db/schema.rs` | `SCHEMA_VERSION` and the version history; the note on derived columns |
| `src-tauri/src/db/migrate.rs` | the one-time JSON import and when the legacy keys are shed |
| `src/lib/librarySync.ts` | `diffAudioFiles` (`null` ≠ empty), `mergeScanned`, `applyPatch`, `pathsMissingBpm` |
| `src/lib/scanPatchBatch.ts` | the 250 ms window, and the per-path merge |
| `src/lib/boot.ts` | `scanLabel`, `scanButtonState` — the button's two faces |
| `src/lib/skipped.ts`, `src/components/SkippedModal.tsx` | the skipped-file report |
| `src/components/LibraryView.tsx` | `rescan`, `incrementalSync`, `startBpmBacklog`, the scan listeners |

Events and their payloads are tabulated in [COMMANDS.md](COMMANDS.md).

## Verification links

| Claim | Test |
| --- | --- |
| An unreadable root is not an empty library | `commands.rs` · `an_unreadable_library_root_is_not_an_empty_library`, `a_run_that_could_not_look_is_never_a_full_sweep` |
| … and the same rule in the frontend | `librarySync.test.ts` · "treats a folder it could not list as no evidence at all"; `LibraryView.test.tsx` · "treats an unreachable folder as unknown, not as empty" |
| Phase 3 runs after a full sweep or a change, never after a cancel | `commands.rs` · `dedupe_runs_after_a_full_sweep_or_a_change_but_never_after_a_cancel` |
| A patch carries only what was found, and rounds the tempo | `commands.rs` · `a_patch_carries_only_what_the_analysis_found`, `a_patch_rounds_the_tempo_to_what_a_tag_can_hold` |
| A waveform-only result is emitted but not persisted | `commands.rs` · `a_waveform_only_patch_changes_no_field_of_the_row`, `a_waveform_alone_is_worth_emitting_but_not_worth_persisting` |
| `null` in a patch means unchanged | `librarySync.test.ts` · "treats a null field as unchanged, not as cleared" |
| A batch never drops tracks it did not mention | `librarySync.test.ts` · "never drops tracks the batch does not mention" |
| Re-analysis only when something changed or is unknown | `db/mod.rs` · `needs_reanalysis_only_when_something_is_unknown_or_changed` |
| A version bump keeps rows and fingerprints | `db/mod.rs` · `version_change_invalidates_identities_but_keeps_tracks_and_fingerprints`, `a_fresh_database_records_its_version_without_invalidating` |
| Derived fields are recomputed on read | `db/mod.rs` · `track_roundtrip_recomputes_derived_fields` |
| The column list and its count cannot drift apart | `db/mod.rs` · `track_columns_and_count_agree` |
| A waveform lives only while file and algorithm match | `db/mod.rs` · `a_waveform_survives_only_while_the_file_and_the_algorithm_match` |
| A fingerprint likewise | `db/mod.rs` · `fingerprint_is_invalidated_by_content_or_algorithm_change` |
| A migrated database looks like a fresh one | `db/mod.rs` · `a_migrated_database_has_the_same_tracks_schema_as_a_fresh_one`, `the_v5_migration_keeps_the_tracks_and_their_fingerprints` |
| The width is the smaller of cores and memory, capped | `workers.rs` · `cores_bind_on_a_machine_with_memory_to_spare`, `memory_binds_on_a_high_core_low_ram_machine`, `the_cap_holds_even_when_the_host_could_do_more`, `never_returns_zero` |
| The excerpt starts after the intro, and never past the end | `analysis.rs` · `the_excerpt_starts_after_the_intro`, `the_excerpt_never_runs_past_the_audio` |
| A burst of patches becomes one list update | `scanPatchBatch.test.ts` · "turns a burst of results into a single list update", "keeps the older value where the newer result has none" |
| The button has its own face while held, and ignores a stale pause | `boot.test.ts` · `scanButtonState` |
| Rows that were on screen during a scan still get their waveform | `LibraryView.test.tsx` · "fills in the rows that were on screen while the scan ran", "also fills them in after a cancelled scan" |
| A file whose tempo cannot be detected is not re-queued forever | `LibraryView.test.tsx` · "does not re-queue a file whose tempo could not be detected" |

Run them with `cd src-tauri && cargo test` and `npm test`; CI
(`.github/workflows/ci.yml`) gates both on every push.

## Keeping this honest

- **A new cache needs a row in the invalidation table above**, plus tests for
  each thing that invalidates it. That is a `CLAUDE.md` rule, not a suggestion.
- **Changing a decode window, sample rate or algorithm config means bumping the
  matching `ALGO_VERSION`.** Nothing else throws those caches away.
- The measured numbers here — `MIN_WRITE_CONFIDENCE`, the tempo accuracy, the
  window position — come from [DSP_BENCHMARK.md](DSP_BENCHMARK.md) and belong
  there, not in a second copy.
- Anchors name a file and a symbol on purpose. If a symbol in the tables above
  no longer exists, that is this document being wrong, and it is meant to be
  visible.
