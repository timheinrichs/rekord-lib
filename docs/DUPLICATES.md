# Duplicate detection

Item **F1** from [FUTURE_CONSIDERATIONS.md](FUTURE_CONSIDERATIONS.md): how the
same track under three different names in two formats gets recognised as one
track, and why almost all of that happens without decoding any audio.

## How it works

The duplicate search is **a scan phase, not a button**. It runs at the end of
every scan that swept the whole library or actually changed something, and it
reports over `dedupe://progress` and `dedupe://done` while it does. Nothing pops
open when it finishes: the count appears on a header button, and the panel is
opened by the user.

```
run_dedupe_phase
 │  candidates ← the whole library from the database, not the files this run saw
 │  sort by duration; pair up everything within DURATION_TOLERANCE (1 s)
 │
 ├─ Tier 0 · metadata    same artist + same normalised core title, ±4 s
 │                       → union, no fingerprint
 ├─ Tier 1 · name        ≥ 2 shared tokens and Jaccard ≥ NAME_HIGH (0.85)
 │                       → union, no fingerprint
 │                       otherwise: both files are marked as needing audio
 │
 ├─ fingerprints         served from the cache; only misses are decoded,
 │                       at the budgeted width, and stored before comparing
 │
 └─ Tier 2 · audio       best segment with score ≤ 5.0 and coverage ≥ 0.7,
                         and either near-identical (≤ 3.0 / ≥ 0.9) or a name
                         that at least half agrees (Jaccard ≥ 0.5)

 components of ≥ 2 files → a group, id = smallest path, keep_id = best quality
 drop the groups the user has dismissed → store → dedupe://done
```

The panel then does one more grouping pass in the frontend: track groups that
share a folder pair are clustered into **albums**, so two copies of the same
release are one decision with a radio button per version rather than twelve.
What is left over is listed as individual tracks.

## Deep technical details

### Three tiers, and only the third one costs a decode

Fingerprinting is the most expensive thing the app does. So the cheap evidence
runs first, and every pair the cheap tiers resolve is never fingerprinted at
all: a pair whose files are already connected is skipped before the token check
even happens. On a normal collection that leaves a small subset to decode.

**Tier 0 (metadata)** exists for a specific failure: a file converted by another
program that mangled the title into `Artist - Album - 01 Title`. The fingerprint
often fails on those — a different encode, a trimmed intro — while the artist
tag and the real title still line up. `core_title` strips a leading track number
and leading segments equal to the artist or album, `norm_album` strips a leading
`Label - `, and the tier demands exact equality of both normalised values. It
gets a **looser duration tolerance (4 s instead of 1)**, because a foreign
convert may shift the length more than a re-encode does.

**Tier 1 (name)** needs at least two shared tokens *and* high similarity.
Extensions, single characters and pure numbers are dropped as tokens, which is
what makes `Song.aiff` and `Song.wav` name-equal.

**Tier 2 (audio)** compares chromaprint fingerprints and takes the best segment.

### Jaccard, not the overlap coefficient

Similarity is intersection over **union**. With the overlap coefficient a subset
scores 1.0, and `Version I` — whose `I` is dropped as a single-character token —
would be a perfect match for every other version of the track, chaining them all
together through union-find. The comment in `token_overlap` says so because the
bug happened.

### Coverage exists because of union-find

A score alone was not enough. Two unrelated tracks that share a beat produce a
weak partial match with coverage around 0.1, and union-find turns a handful of
those into one enormous group. Requiring the matched segment to cover at least
70 % of the shorter fingerprint is what stops that. Near-identical audio (score
≤ 3.0, coverage ≥ 0.9) is accepted regardless of the name; anything weaker still
needs the name to half agree.

### Candidates come from the database

Not from the run. A targeted scan that touched three files would otherwise
compare them against nothing at all. The consequence is that the search always
sees the whole library, which is only affordable because fingerprints are cached
across runs — and *that* is what makes dismissals necessary.

### Dismissals are a separate table

`duplicate_groups` is a result cache: the search overwrites it wholesale. A "not
a duplicate" decision stored in there would be gone on the next scan, and since
the search runs after every scan, every waved-off group would come back within
minutes. So `dismissed_groups` holds ids of its own, and `drop_dismissed`
filters the fresh result through it.

The failure direction is deliberate: if the dismissals cannot be read, a
dismissed group is shown again. Showing something the user already judged is
recoverable; hiding a real duplicate is not.

**The group id is the smallest member path**, which is stable across runs but
not across deletions — remove that file and the group comes back once under a
new id. The same is true after a relocate, which rewrites every path (**C2a** in
[TODO.md](../TODO.md)).

### Fingerprints are stored before the comparison

Not after. The compare phase over a large library is long, and a cancel or a
crash during it must not throw away decodes that already happened. The progress
counter also counts **only cache misses**, which is why a warm cache shows
"Finding duplicates…" with no numbers at all.

### Which copy to keep

`quality_key` ranks a file by `(lossless, sample rate, bit depth, size)` and the
best one becomes `keep_id` — a suggestion, not a decision; the panel lets the
user pick.

The **album** ranking in the frontend is deliberately different: lossless, then
more tracks, then *shorter average title*, then larger size. The average title
length is a proxy for clean metadata — the folder whose titles are not `Artist -
Album - 01 Title` is the one worth keeping.

### Deleting

Everything goes to the macOS trash, never `remove_file`, and deleting also
forgets the rows so the cache stops serving them; fingerprints and waveforms
follow through `ON DELETE CASCADE`. An album folder is trashed whole only when
`dir_holds_only` confirms it holds no other audio — otherwise the files go
individually and empty folders are pruned afterwards, with the backend
re-checking for audio before it removes a directory.

Groups are pruned against the track list reactively rather than on an event,
because the scan streams its updates and a group can lose a member at any
moment.

## Implementation anchors

| Where | What |
| --- | --- |
| `src-tauri/src/audio/dedupe.rs` · `find_duplicates` | the whole search: pairing, the three tiers, fingerprints, grouping |
| … · thresholds | `AUDIO_SCORE_MAX`, `COVERAGE_MIN`, `NAME_HIGH`, `NAME_MIN`, `IDENTICAL_SCORE`, `IDENTICAL_COVERAGE`, `DURATION_TOLERANCE`, `METADATA_DURATION_TOLERANCE`, `EXT_TOKENS` |
| … · `name_tokens`, `token_overlap` | tokenisation and Jaccard, with the reason it is Jaccard |
| … · `norm_text`, `norm_album`, `core_title`, `strip_leading_track_number` | the metadata tier's normalisation |
| … · `best_match`, `audio_duplicate` | the fingerprint comparison and the accept rule |
| … · `uf_find`, `uf_union`, `quality_key` | grouping, and which copy is suggested |
| … · `cached_fingerprints`, `store_fingerprint`, `FP_CONCURRENCY`, `FP_WORKER_BYTES` | the cache and the width of the decode pass |
| `src-tauri/src/audio/fingerprint.rs` | `FINGERPRINT_SECS`, `config`, `fingerprint`, `ALGO_VERSION` |
| `src-tauri/src/commands.rs` · `run_dedupe_phase`, `dup_candidates` | the phase, and what a candidate carries |
| … · `drop_dismissed`, `persist_duplicate_groups`, `dedupe_after_scan` | dismissals, storage, and when the phase runs at all |
| … · `delete_files`, `delete_album`, `prune_empty_dirs`, `dir_holds_only`, `forget_deleted`, `trash_ctx` | the delete side |
| `src-tauri/src/db/mod.rs` · `save_duplicate_groups`, `load_dismissed`, `dismiss_group` | the result cache and the separate dismissal store |
| … · `fingerprints_load`, `fingerprint_put`, `encode_fingerprint` | the fingerprint cache and its blob format |
| `src-tauri/src/db/schema.rs` | `duplicate_groups`, `dismissed_groups`, `fingerprints` |
| `src/lib/dupAlbums.ts` · `clusterAlbums`, `deleteSetForAlbum`, `foldersToPrune` | album clustering and what a chosen version implies |
| `src/lib/grouping.ts` · `pruneGroups` | keeping the groups honest as the list changes |
| `src/lib/duplicates.ts` | `loadDuplicates`, `saveDuplicates`, `dismissDuplicates` |
| `src/components/DuplicatesModal.tsx` | the panel: album versions, lone tracks, "not a duplicate" |

## Verification links

| Claim | Test |
| --- | --- |
| Similarity is Jaccard, and empty sets score zero | `dedupe.rs` · `token_overlap_is_jaccard`, `token_overlap_empty_sets_zero` |
| Extensions, single chars and numbers are not tokens | `dedupe.rs` · `name_tokens_drops_extension_single_char_and_numbers`, `name_tokens_equal_across_formats` |
| The metadata tier catches a mangled title and rejects a different artist | `dedupe.rs` · `metadata_tier_matches_clean_and_mangled`, `metadata_tier_rejects_different_artist_or_length` |
| Normalisation strips what it claims to | `dedupe.rs` · `norm_text_keeps_alphanumerics_only`, `norm_album_strips_label_prefix`, `core_title_unmangles_the_screenshot_case` |
| Lossless beats lossy, then rate, bits, size | `dedupe.rs` · `quality_key_prefers_lossless_then_rate_bits_size` |
| Union-find merges transitively | `dedupe.rs` · `union_find_merges_components` |
| A candidate carries what the search compares | `commands.rs` · `dup_candidates_carry_the_fields_the_search_compares` |
| The phase runs after a sweep or a change, never after a cancel | `commands.rs` · `dedupe_runs_after_a_full_sweep_or_a_change_but_never_after_a_cancel` |
| A folder is only trashed whole when it holds nothing else | `commands.rs` · `dir_holds_only_detects_exclusive_album_folders`, `prune_empty_dirs_keeps_folders_with_audio` |
| The result is replaced wholesale; dismissals are independent of it | `db/mod.rs` · `duplicate_groups_are_replaced_wholesale_and_need_an_id`, `dismissals_are_independent_of_the_result_cache`, `dismissed_groups_round_trip_and_tolerate_repeats` |
| A fingerprint dies with its file or its algorithm | `db/mod.rs` · `fingerprint_is_invalidated_by_content_or_algorithm_change`, `fingerprint_blob_roundtrips`, `delete_tracks_removes_rows_and_their_fingerprints` |
| Two folders of one album cluster, and one shared track does not | `dupAlbums.test.ts` · "clusters two folders of the same album into one album with two versions", "does not form an album from a single shared track" |
| The album suggestion prefers lossless, then the cleaner titles | `dupAlbums.test.ts` · "prefers lossless over lossy for the keep suggestion", "suggests keeping the cleaner (shorter-title) version when quality ties" |
| Groups shrink with the list and drop below two files | `grouping.test.ts` · `pruneGroups` — "drops removed files and shrinks the group", "discards groups that fall below two files", "corrects keep_id when the kept file is gone" |
| An empty save is how the cache is cleared | `duplicates.test.ts` · "saves an empty result too (that is how the cache is cleared)" |

Test data for the real thing: `scripts/dev-library.py` generates a duplicate
pair plus a nested copy under `Duplicates/`, so a dev run has a group to look
at.

## Keeping this honest

- **`find_duplicates` itself has no test** — it needs an `AppHandle` — and Tier
  0 is verified through a mirror of the inlined logic, which can drift from it.
  Both are recorded in [TODO.md](../TODO.md); a change to the tier logic should
  not lean on those tests alone.
- **`norm_text` and `norm_album` exist twice**, in `dedupe.rs` and in
  `dupAlbums.ts`, with no shared test asserting they agree. Change one, change
  the other.
- **`dupAlbums.ts` is invisible to `grep`.** It uses a literal NUL character as
  the separator in its folder-pair keys (`` `${a}\0${b}` ``), which makes every
  tool that sniffs for binary content — `grep`, `file`, GitHub's diff view —
  treat the file as data. Search it with `grep -a`. A printable separator that
  cannot occur in a path (`\x1f`, say) would remove the trap; nothing depends on
  it being NUL.
- Thresholds are tuned against a real collection, not derived. Moving one means
  looking at what it does to a library of a few thousand tracks, not at a unit
  test.
- A dismissal is keyed by the group id, which is a path. Anything that rewrites
  paths invalidates dismissals.
