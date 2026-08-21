# The command surface

Item **F6** from [FUTURE_CONSIDERATIONS.md](FUTURE_CONSIDERATIONS.md): a
reference for everything the frontend can ask the backend to do, and everything
the backend says back unasked. Name, arguments, return, events.

Every command lives in `src-tauri/src/commands.rs` and is registered in the
`generate_handler!` block in `src-tauri/src/lib.rs`. Nothing else in the tree
carries `#[tauri::command]`, so this one file is the whole surface. On the other
side there is no generated binding layer: four thin modules wrap `invoke`, and
**no component calls `invoke` directly**.

| Wrapper module | Covers |
| --- | --- |
| `src/lib/api.ts` | most commands, and every event listener except the log |
| `src/lib/library.ts` | `library_*`, `edits_load`, `edit_set`, `edit_clear` |
| `src/lib/events.ts` | `events_*` and `events://new` |
| `src/lib/duplicates.ts` | `duplicates_*` |

## Two rules that hold everywhere

Said once here rather than repeated in forty rows.

**Arguments are camelCase, payloads are snake_case.** Tauri renames generated
argument structs, so an `analyze_bpm: bool` parameter is `analyzeBpm` in the
`invoke` call. Nothing in `src-tauri/src/models.rs` carries `rename_all`,
so everything coming *back* — return values and event payloads alike — keeps its
Rust field names: `file_name`, `has_result`, `key_camelot`, `seen_id`. The
hand-written mirror in `src/types.ts` follows the same split.

**A plain return type never rejects.** `AppResult<T>` serialises its error as a
string (`src-tauri/src/error.rs`), so those calls reject with a `string` and
nothing else. A command returning a bare value cannot fail from the caller's
point of view, and several report failure *inside* the value instead:
`write_metadata`, `delete_files`, `delete_album` and `prune_empty_dirs` carry a
per-item `error`, and `bandcamp_download` returns `Ok` with `success: false`.
Wrapping those in a `try`/`catch` and calling it error handling is the mistake
this section exists to prevent.

## Analysis and waveforms

| Command | Arguments | Returns | Emits |
| --- | --- | --- | --- |
| `analyze_files` | `paths`, `analyzeBpm`, `libraryDir?`, `bpmMin?`, `bpmMax?` | `AppResult<TrackAnalysis[]>` | `scan://skipped`, `events://new` |
| `waveform` | `path` | `AppResult<Waveform>` | — |
| `stored_waveforms` | `paths` | `AppResult<Record<string, Waveform>>` | — |

`analyze_files` is the blocking path: it probes, evaluates compatibility, reads
tags and optionally detects a tempo, and it returns only when the whole list is
done. Its remaining caller is the import of files dragged in from outside the
library, which are handled one at a time and have no folder to sweep. The
incremental sync used to use it for newly appeared files too, which is why the
first population of a library could not be paused; those now go to `start_scan`
as a targeted run.

`stored_waveforms` answers from the database and never decodes; `waveform`
decodes when it has to. `src/lib/api.ts` asks the stored one first, which is
what keeps a list of rows from starting a decode per visible row. See
[SCANNING.md](SCANNING.md).

## The scan job

| Command | Arguments | Returns | Emits |
| --- | --- | --- | --- |
| `start_scan` | `dir`, `analyzeBpm`, `paths?`, `forceBpm`, `force`, `bpmMin?`, `bpmMax?` | `bool` — `false` means one was already running | `scan://progress`, `scan://tracks`, `scan://patch`, `scan://skipped`, `scan://done`, plus `dedupe://*` from its third phase |
| `scan_status` | — | `ScanStatus` | — |
| `set_scan_paused` | `paused` | `()` | `scan://progress` |
| `cancel_scan` | — | `()` | — |
| `list_audio_files` | `dir` | `string[]` | — |
| `start_library_watch` | `dir` — an empty string stops the watcher | `AppResult<()>` | `library://changed` |
| `sidecar_error` | — | `string \| null` | — |

`start_scan` is a single-flight background job, not a request: it returns
immediately and reports through events, and a second call while one runs returns
`false` rather than queueing. `scan_status` exists so a reloaded window can
reattach to a run in progress.

`cancel_scan` also cancels the duplicate phase, and `cancel_dedupe` clears the
scan's pause flag — the two are coupled because the duplicate search *is* a scan
phase. Neither has a caller in the UI today; the scan button is pause/resume
only. So is `force`, the deep re-probe that bypasses the identity cache: it is
reachable through this API and no view passes `true`. Only `forceBpm` is, from
*Re-detect BPM* in the settings.

## Library and edits

| Command | Arguments | Returns |
| --- | --- | --- |
| `library_load` | `dir` | `AppResult<TrackAnalysis[]>` |
| `library_delete` | `paths` | `AppResult<number>` — rows forgotten |
| `library_dir_available` | `dir` | `bool` |
| `library_relocate` | `oldDir`, `newDir` | `AppResult<RelocateResult>` |
| `allow_library_playback` | — | `()` |
| `edits_load` | — | `AppResult<Record<string, TrackEdit>>` |
| `edit_set` | `path`, `edit` | `AppResult<()>` |
| `edit_clear` | `paths` | `AppResult<()>` |

`library_delete` forgets rows; it does not touch files. Deleting a file is
`delete_files`. `library_relocate` re-points stored paths at a moved folder and
never deletes: what it cannot find under the new root is reported as skipped.

`allow_library_playback` grants the webview read access to the **saved** library
folder over the `asset:` protocol, for this run only — the static scope in
`tauri.conf.json` is empty, so until it is called `convertFileSrc` resolves to a
URL the webview may not load. It takes no argument on purpose: a command that
granted whatever it was handed would let anything running in the window ask for
`$HOME` back, which is the scope this exists to remove. The folder therefore
comes from the store, which means the frontend calls it **after** the settings
are written; the backend grants the same folder at startup, so playback works
before the first call arrives. A path that is relative, is the root, or resolves
to a single component (`/Users`, `/Volumes`) is ignored.

`edits_load`, `edit_set`, `duplicates_load` and `duplicates_save` are typed
`serde_json::Value` in Rust while TypeScript asserts `TrackEdit` and
`DuplicateGroup`. That contract is unchecked on both sides — deliberately, since
the shape belongs to the UI, but worth knowing before trusting it.

## Duplicates

| Command | Arguments | Returns |
| --- | --- | --- |
| `duplicates_load` | — | `AppResult<DuplicateGroup[]>` |
| `duplicates_save` | `groups` | `AppResult<()>` |
| `duplicates_dismiss` | `id` | `AppResult<()>` |
| `dedupe_status` | — | `DedupeStatus` |
| `dedupe_result` | — | `DuplicateGroup[] \| null` |
| `cancel_dedupe` | — | `()` |

The last three have no UI caller. `duplicates_save` with an empty array is how
the cached result is cleared. See [DUPLICATES.md](DUPLICATES.md) for why
dismissals are a separate store rather than a flag on a group.

## Metadata

| Command | Arguments | Returns | Emits |
| --- | --- | --- | --- |
| `suggest_metadata` | `path` | `AppResult<MetadataSuggestions>` | — |
| `discogs_credentials` | — | `DiscogsStatus` | — |
| `set_discogs_credentials` | `key`, `secret` | `AppResult<()>` | — |
| `clear_discogs_credentials` | — | `AppResult<()>` | — |
| `cover_preview` | `source`, `cover` | `AppResult<string \| null>` — a `data:` URL | — |
| `cover_thumbnail` | `path` | `AppResult<string \| null>` — a `data:` URL | — |
| `write_metadata` | `items`, `recordUndo?`, `label?` | `WriteMetadataResult[]` — never rejects | `scan://skipped`, `events://new` |
| `undo_peek` | — | `AppResult<UndoEntry \| null>` | — |
| `undo_last` | — | `AppResult<WriteMetadataResult[]>` | `scan://skipped` |

`suggest_metadata` takes no credentials: they live in the macOS Keychain and the
backend reads them itself, so a secret never travels with a request.
`discogs_credentials` answers `{ stored, unavailable, key }` — never the secret
half; `unavailable` means the Keychain could not be asked, which is a different
thing from nothing being stored and is what settings puts on screen.

`write_metadata` reports per item because a bulk edit over a selection must not
lose the twelve files that worked because the thirteenth was read-only. It also
emits `scan://skipped` for a file whose tags were written but could not be read
back — the write succeeded and the row could not be refreshed, which is worth
saying out loud rather than silently showing stale values. Details in
[METADATA.md](METADATA.md).

## Conversion

| Command | Arguments | Returns | Emits |
| --- | --- | --- | --- |
| `convert_tracks` | `jobs`, `options` | `AppResult<ConvertResult[]>` | `convert://progress` |

One command for the whole pipeline, and it runs the jobs strictly sequentially —
the only pass in the app that is not width-budgeted, because ffmpeg saturates
what it is given. Progress arrives twice from different places: from
`audio/convert.rs` while ffmpeg runs, and once more from `commands.rs` with
`stage: "Metadata"` for the tagging phase afterwards. See
[CONVERSION.md](CONVERSION.md).

## Deletion

| Command | Arguments | Returns | Emits |
| --- | --- | --- | --- |
| `delete_files` | `paths` | `DeleteResult[]` | `events://new` on a failed prune |
| `delete_album` | `dir`, `paths` | `DeleteResult[]` | same |
| `prune_empty_dirs` | `dirs` | `DeleteResult[]` | — |

Everything here goes to the macOS trash, never `remove_file` — these are the
user's own audio files. `delete_album` returns one entry per path even when it
trashed the folder in one move, so the caller does not have to know which
happened.

## The event log

| Command | Arguments | Returns |
| --- | --- | --- |
| `events_load` | — | `AppResult<EventLog>` — entries plus `seen_id` |
| `events_mark_seen` | `id` | `AppResult<()>` |
| `events_clear` | — | `AppResult<number>` |

## Bandcamp

| Command | Arguments | Returns | Emits |
| --- | --- | --- | --- |
| `bandcamp_login` | — | `AppResult<()>` | — |
| `bandcamp_connect` | — | `AppResult<BandcampAccount>` | — |
| `bandcamp_disconnect` | — | `AppResult<()>` | — |
| `bandcamp_status` | — | `AppResult<BandcampAccount \| null>` | — |
| `bandcamp_collection` | — | `AppResult<BandcampItem[]>` | — |
| `bandcamp_download` | `key`, `pageUrl`, `destDir`, `format?` | `AppResult<BandcampDownloadResult>` | `bandcamp://progress` |
| `cancel_bandcamp_download` | `key` | `()` | — |

`bandcamp_download` reports a failure as `success: false` inside an `Ok`, not as
a rejection, so a failed download is a row in the list rather than an exception.

## Events

All of them are global `app.emit`; there is no `emit_to` and no channel
anywhere, so every window sees every event. Payload types are mirrored by hand
in `src/types.ts`.

| Event | Payload | Emitted from |
| --- | --- | --- |
| `scan://progress` | `ScanProgress { generation, done, total, running, paused, stage }` | `commands.rs` `emit_progress` |
| `scan://tracks` | `ScanTracks { generation, tracks }` — batched | `commands.rs` `emit_tracks` |
| `scan://patch` | `ScanPatch { generation, patch: TrackPatch }` — one per finished file | `commands.rs` `emit_patch` |
| `scan://skipped` | `SkippedFile { path, file_name, reason }` | `commands.rs` `record_skip` |
| `scan://done` | `ScanDone { generation, cancelled, full, tracks }` | `commands.rs` `start_scan` |
| `dedupe://progress` | `DedupeProgress { generation, done, total, stage, running }` | `audio/dedupe.rs` |
| `dedupe://done` | `DedupeDone { generation, cancelled, groups }` | `commands.rs` `run_dedupe_phase` |
| `convert://progress` | `ConvertProgress { id, percent, stage }` | `audio/convert.rs` and `commands.rs` |
| `bandcamp://progress` | `{ key, downloaded, total, stage }` | `bandcamp/download.rs` |
| `library://changed` | `()` | `commands.rs` watcher callback |
| `events://new` | `()` | `events.rs` `record` |

Two things about `generation`: it is stamped on every scan and dedupe event so a
listener *could* drop results from a superseded run, and no listener does. Stale
results are harmless instead by construction — `applyPatch` ignores a path it
does not know and `mergeScanned` never drops a track the batch did not mention.

`events://new` fires from every `events::warn`/`events::error` call, which means
indirectly from most commands. It carries no payload; the listener reloads.

## Keeping this honest

- **Do not trust a count in this file, re-derive it.** The definitions and the
  registration must agree:

  ```sh
  grep -c '^#\[tauri::command\]' src-tauri/src/commands.rs
  ```

  against the `generate_handler!` list in `src-tauri/src/lib.rs`. They were
  identical when this file was written; a command defined and not registered
  fails only at the call site, at runtime.
- **Find events by searching for `app.emit`**, not by helper name:
  `emit_progress` exists three times with three different signatures, in
  `commands.rs`, `audio/convert.rs` and `bandcamp/download.rs`.
- **A new command belongs in a table here with its events**, and a new event
  belongs in `src/types.ts` as well. `STAGE_WAVEFORM` in `commands.rs` has no
  counterpart there, which is the shape that drift takes.
- The frontend wrapper names do not always match the command
  (`library_load` → `loadLibraryTracks`, `library_delete` → `forgetTracks`), so
  grep for the command string when following a call from a view.
