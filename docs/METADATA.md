# Tags, covers and undo

Item **F1** from [FUTURE_CONSIDERATIONS.md](FUTURE_CONSIDERATIONS.md): what the
app reads out of a file, what it writes back, and what it takes to be able to
take that back. Everything here writes into the user's own files, which is why
most of the detail below is about being careful rather than about being clever.

## How it works

```
read        lofty → TrackMetadata { title, artist, album, album_artist, genre,
            year, track_number, catalog_number, label, country, bpm, has_cover }
            no embedded cover? a cover image next to the file counts too

suggest     suggest_metadata(path)
            ├─ the file's current tags
            ├─ a guess from the filename and folder ("01 - Artist - Title")
            ├─ MusicBrainz candidates (artist + title)
            └─ Discogs per-field chips — genres, years, labels, countries,
               only with credentials configured

write       write_metadata(items, recordUndo?, label?)
            ├─ capture what the files hold right now → one undo entry
            └─ per file: finalize(..., clear_empty = true)
                 cover → process_cover → 800 px, < 100 KB JPEG
                 text  → the mapped ItemKey per field, BPM key per format
                 then re-read the file so the row shows what is really in it

undo        undo_last() replays the captured entry through the same write path
            and drops the entry in one step
```

The scan's BPM pass writes tags too, but through a separate narrow path:
`write_bpm` touches exactly one tag and nothing else. Routing it through
`finalize` would resolve and re-encode the cover of every file it detects a
tempo for.

## Deep technical details

### What counts as complete

`TrackMetadata::is_complete` requires title, artist, album and album artist —
nothing else. Genre, year, catalogue number, label, country and **BPM** are
deliberately optional: most files arrive with no BPM tag, and calling them
incomplete for it would mark a whole library red on import. The musical key is
absent from the check for the same reason, and is never written into a file at
all — see [DSP_BENCHMARK.md](DSP_BENCHMARK.md) for why a detected key stays in
the database.

`metadata_incomplete` is recomputed on read like `compat`, so changing this rule
takes effect immediately rather than leaving stale verdicts in rows.

### Covers, and the two places they can live

`read_cover_or_sidecar` prefers the embedded front cover, falls back to the
first embedded picture of any type, and then to an image file in the same
folder. `find_sidecar_cover` prefers a known name — `cover`, `folder`, `front`,
`album`, `artwork`, … — and otherwise takes the first image alphabetically. Many
collections store artwork as `cover.jpg` rather than embedding it, and
conversion embeds what it finds.

`has_sidecar_cover` exists as the cheap version of that question: it only asks
whether the folder holds any image, without reading one, because it is called
per row while a library loads.

**Covers are normalised for the hardware.** `process_cover` caps the long edge
at 800 px and targets under 100 KB of JPEG. A 4000 px cover is not better on a
player; it is a file that takes longer to load.

**"No cover" strips every picture, not just the front one.** Because
`read_cover_bytes` falls back to a picture of any type, leaving a stray back
cover in place would keep showing it as the track's artwork, and removing the
cover would look like it did nothing. lofty has no "clear all pictures", so
`apply_cover` removes index 0 until the list is empty.

### `clear_empty` is the difference between a save and an undo

`finalize` takes a flag. With `clear_empty = false` — what conversion uses — a
field left unset keeps whatever the file already had, because a conversion is
not an assertion about the tags. With `clear_empty = true` — what the editor and
undo use — an empty field **removes** the tag, because the caller is sending the
file's full intended state and an undo has to be able to restore a field back to
empty.

### The BPM tag needs the right key per format

lofty maps `IntegerBpm` for ID3v2 and MP4, and `Bpm` for Vorbis comments, and it
drops an unmapped key **silently** on write. A single hardcoded key therefore
writes a tempo into an AIFF and quietly loses it in a FLAC. `bpm_key(tag_type)`
picks per format, and two tests exist purely to prove that a hardcoded key would
be dropped.

`format_bpm` writes two decimals the way Rekordbox does. Fixed decimals keep the
round trip stable: read gives `128.0`, write gives `"128.00"`, read gives
`128.0` again — so saving a file twice does not keep changing its tag. The
library *displays* whole beats, which is only safe because the editor's tempo
field keeps its stored value unless it is actually edited; otherwise any save
would write `128` over a stored `127.61`.

### What undo captures, and what it deliberately does not

The snapshot is taken **in the backend, from the files' real tags** — not from
whatever the list happened to be showing. One entry per *edit*, not per file: a
bulk edit across 200 tracks was one action and is undone as one.

The cover is the interesting part. `undo_cover_for` decides:

| The write does | The file has embedded artwork | The undo instruction |
| --- | --- | --- |
| `Keep` | yes | `Keep` — it was never touched, restoring it is free |
| anything else | yes | the previous bytes, captured |
| anything | no | `None` — which also takes back a cover that `Keep` pulled in from a `cover.jpg` |

So bytes are only captured when a write actually replaces embedded artwork. That
is what keeps a 200-track text edit's undo entry small, and it is why the
history can be 20 entries deep without growing without bound.

Three deliberate failure directions: a file that cannot be read is left out of
the snapshot rather than failing the batch, because there is nothing to restore
it to; a snapshot that cannot be stored costs the undo and not the write the
user asked for, and says so in the event log; and an entry whose payload no
longer parses is deleted so it cannot sit at the top of the stack blocking the
button forever.

`undo_last` restores and drops the entry in one step, so a failed restore does
not also lose the entry.

**Undo puts the bytes back, not a likeness of them.** The captured item carries
`cover_verbatim` — set only where bytes were really captured, since `Keep`
resolves against the file as it is at undo time and `None` embeds nothing — and
`finalize` then embeds exactly what it was given, with the
mime type read off the bytes rather than assumed — what a file held before a
write is not necessarily a JPEG, and a PNG labelled as one is a cover players
refuse to draw. Restoring a 3000 px original is *correct here*: undo's contract
is the state before the write, not a CDJ-shaped approximation of it. Bytes that
cannot be identified as an image fall back to the encoder rather than being
embedded on a guess.

An added field rather than a new `CoverInput` variant, deliberately: serde
ignores a field it does not know, so an older build reading a newer undo entry
behaves the way it always did, where an unknown variant would fail to
deserialize outright.

**An ordinary write no longer re-encodes a cover that is already right.**
`Keep` resolves to the artwork already in the file, and every write used to send
it through `process_cover` again — the same picture, one generation worse, on
every edit. `artwork::already_cdj_shaped` answers whether the bytes are already
what the encoder would produce (a JPEG inside the 800 px edge and 100 KB budget,
judged from the JPEG frame header rather than a decode) and the encode is
skipped when they are. Narrow on purpose: a PNG is still converted, because that
conversion is part of what CDJ-shaped means, and anything unreadable takes the
old path.

### Writing is per item, and reports per item

`write_metadata` returns a result per file and never rejects. A bulk edit must
not lose the twelve files that worked because the thirteenth is read-only. A
file whose tags were written but could not be **re-read** is reported through
`scan://skipped` — the write succeeded, the row keeps its old values, and that
is worth saying rather than showing stale data silently.

### An unapplied edit is still an answer

An edit lives in the `edits` table from the moment it is made and only reaches
the file when it is applied, so between those two points the table shows one
value and the file holds another. Everything that reads the library reads the
edit: the grouping, the album and label trees, the conversion job — and, since
0.8.1, the Rekordbox export, which used to read the rows alone and therefore
wrote tags the user had already corrected. See
[PLAYLISTS.md](PLAYLISTS.md#the-export) for how the export reads the payload
without the rest of the backend learning its shape.

The one place this is more than a copied value: an edited BPM moves the
`<TEMPO>` marker's period while the phase stays where the detector put it. That
is the right answer — a corrected tempo is a corrected grid — and it is the only
field of an edit that changes something other than a tag.

### Suggestions

`parse_filename` handles the patterns real purchases arrive in — `NN - Artist -
Title`, `Artist - Title`, `NN Title`, `Title` — and takes the album from the
folder name. It is a guess offered next to the field, never written on its own.

Existing tags beat the filename guess as the query basis for MusicBrainz. Both
network sides fail soft: no client or an error yields fewer suggestions, never
an error dialog.

**Discogs needs no account.** `/database/search` answers unauthenticated
requests — measured 2026-08-26, returning exactly the four fields the chips are
built from — at 25 requests per minute instead of 60, throttled by source IP.
Credentials are therefore optional and buy the higher limit, nothing else.
Discogs *documents* the endpoint as requiring authentication, so the app watches
for the day that becomes true: a 401/403 on a request that carried no credential
is recorded once per run in the event log, because the alternative is chips that
quietly stop appearing.

A credential takes one of two forms, one at a time: the user's **personal access
token**, or a registered application's **consumer key and secret**. They are
worth the same to the API, so settings offers the token first — a string copied
from a settings page rather than an application somebody has to register.

Either form lives in the **macOS Keychain** — keyed by the bundle identifier, so
the `-devtest` build has its own and a dev run cannot read the installed app's.
The frontend writes it once and afterwards only asks *whether* something is
stored, *which form* it is and *when* it was saved — **no part of the credential
comes back**, not even the consumer key, which until 0.9.0 was rendered in
settings and so ended up on every screenshot of that screen. A pair left in
`rekord-lib.json` by an older version is moved on the next start and the keys
are deleted. It **fails closed**: a Keychain that will not answer means the
credential is not used and a note in settings asking for it again — never a
fallback to a plaintext copy. The suggestions themselves keep working, at the
anonymous limit.

## Implementation anchors

| Where | What |
| --- | --- |
| `src-tauri/src/metadata/read.rs` · `read_metadata` | every field, and the sidecar-cover fallback for `has_cover` |
| `src-tauri/src/metadata/write.rs` · `finalize` | the whole write: cover, text fields, `clear_empty`, save |
| … · `write_bpm` | the scan's narrow one-tag path |
| … · `apply_cover` | replacing the front cover, and stripping every picture |
| … · `bpm_key`, `format_bpm`, `clean` | per-format BPM key, Rekordbox spelling, trimming |
| … · `read_cover_bytes`, `find_sidecar_cover`, `read_cover_or_sidecar`, `has_sidecar_cover`, `COVER_NAMES`, `COVER_EXTS` | where a cover comes from |
| … · `resolve_cover` | the `CoverInput` cases: keep, none, file, bytes, MusicBrainz |
| `src-tauri/src/metadata/artwork.rs` · `process_cover`, `thumbnail` | `MAX_EDGE`, `TARGET_BYTES`, and the list thumbnails |
| `src-tauri/src/metadata/suggest.rs` · `parse_filename`, `search_musicbrainz`, `suggest` | the guess and the candidates |
| `src-tauri/src/metadata/discogs.rs` · `search`, `aggregate` | the per-field chips, with or without a credential |
| … · `Credential::header`, `refused` | the two auth forms, and what counts as "Discogs closed the anonymous search" |
| `src-tauri/src/secrets.rs` · `discogs`, `set_token`, `set_app`, `replace`, `status`, `status_from`, `service`, `migrate_from_store` | the Keychain items, per bundle identifier, one credential at a time, and the one-time move out of the JSON store |
| `src-tauri/src/commands.rs` · `report_discogs_denied` | the once-per-run event when Discogs turns an anonymous search away |
| `src-tauri/src/models.rs` · `TrackMetadata::is_complete` | what "incomplete" means |
| `src-tauri/src/commands.rs` · `write_metadata`, `write_items` | per-item results, `clear_empty = true`, the re-read |
| … · `capture_undo`, `undo_cover_for`, `store_undo`, `undo_last`, `undo_peek` | the snapshot and the restore |
| `src-tauri/src/db/mod.rs` · `push_undo`, `latest_undo`, `drop_undo`, `MAX_UNDO_ENTRIES` | the history, its depth and its pruning |
| `src/components/MetadataEditor.tsx`, `BulkMetadataEditor.tsx` | the editors |
| `src/lib/coverCache.ts` · `createCoverCache`, `forget` | the thumbnail cache and the rule that invalidates it |
| `src/components/CoverThumb.tsx` · `forgetCoverThumbs` | the row's thumbnail, and what the write path calls to drop it |
| `src-tauri/src/metadata/write.rs` · `prepare_cover`, `mime_of`, `finalize_cover` | re-encode, embed verbatim, or skip an encode that would change nothing |
| `src-tauri/src/metadata/artwork.rs` · `already_cdj_shaped`, `jpeg_size` | whether the bytes are already what the encoder would produce |
| `src/lib/writeResults.ts` | folding write results back into the list |

## Verification links

| Claim | Test |
| --- | --- |
| Only the four text fields are required | `models.rs` · `is_complete_true_when_all_text_fields_set`, `is_complete_ignores_optional_catalog_label_genre_year_and_bpm` |
| "No cover" removes every picture | `write.rs` · `no_cover_strips_every_picture_not_just_the_front_one`, `no_cover_removes_the_artwork_from_the_file` |
| Keeping a cover touches nothing; a new one replaces the front | `write.rs` · `keeping_the_cover_leaves_the_pictures_alone`, `a_new_cover_replaces_only_the_front_cover` |
| Sidecar covers prefer a known name, else the first image | `write.rs` · `sidecar_prefers_known_cover_name`, `sidecar_falls_back_to_first_image`, `sidecar_none_when_no_image` |
| Every format we write has a mapped BPM key | `write.rs` · `bpm_key_is_actually_mapped_for_every_format_we_write`, `a_single_hardcoded_bpm_key_would_be_dropped` |
| A tempo survives a tag round trip with its decimals | `write.rs` · `bpm_keeps_its_decimals_through_a_tag_round_trip`, `format_bpm_is_stable_and_rekordbox_shaped`, `bpm_survives_a_generic_tag_round_trip` |
| Empty fields are trimmed away rather than written | `write.rs` · `clean_trims_and_drops_empty` |
| Undo captures cover bytes only when it has to | `commands.rs` · `keep_over_an_embedded_cover_needs_no_bytes`, `a_replaced_cover_is_captured_as_bytes`, `keep_without_an_embedded_cover_undoes_to_none`, `removing_a_cover_that_was_never_there_undoes_to_none`, `an_unset_cover_is_treated_as_keep` |
| An entry round-trips, the newest is undone first, dropping exposes the one below | `db/mod.rs` · `an_undo_entry_comes_back_exactly_as_it_went_in`, `the_newest_write_is_the_one_undone_next`, and the drop test beside them |
| The filename guess handles the real patterns | `suggest.rs` · `parse_track_artist_title_with_number` and the sibling cases |
| Undo returns the file's own cover bytes, not a re-encode | `write.rs` · `an_undo_puts_the_original_bytes_back`, `a_restored_png_stays_a_png_and_says_so` |
| The snapshot asks for that | `commands.rs` · `a_captured_item_restores_its_cover_verbatim` |
| An already CDJ-shaped cover survives an ordinary write untouched | `write.rs` · `an_ordinary_write_stops_re_encoding_a_cover_that_is_already_right`, `artwork.rs` · `process_cover_produces_something_it_then_recognises` |
| A written file's thumbnail is re-read instead of served from the cache | `coverCache.test.ts` · "re-asks for a forgotten path a row is still showing", `CoverThumb.test.tsx` · "shows the new artwork after the file was written, without remounting", `metadata.e2e.test.tsx` · "re-reads the thumbnail of a file it wrote" |
| The dev build cannot reach the installed app's credentials | `secrets.rs` · `service_is_per_bundle_identifier` |
| Only a complete pair is migrated out of the JSON store | `secrets.rs` · `legacy_pair_takes_only_a_complete_credential` |
| A stale legacy pair never replaces a newer credential | `secrets.rs` · `a_legacy_pair_never_replaces_a_newer_credential` |
| An empty value cannot clear a stored credential | `secrets.rs` · `an_empty_value_is_refused_before_anything_is_cleared` |
| A dropped settings key cannot be written back | `settings.test.ts` · `does not carry the Discogs credentials any more` |
| The secret does not travel with a suggestion request | `metadata.e2e.test.tsx` · `asks for suggestions without carrying the Discogs secret` |
| A Discogs chip reaches the editor with no credential stored at all | `metadata.e2e.test.tsx` · `suggests without a credential, because Discogs allows it` |
| No part of a credential reaches the frontend, or the screen | `secrets.rs` · `a_status_carries_no_credential_material`, `SettingsView.test.tsx` · `never renders stored credential material` |
| A token wins over a pair, and half a pair is nothing | `secrets.rs` · `a_token_beats_a_pair_and_half_a_pair_is_nothing`, `the_date_belongs_to_a_credential_that_is_there` |
| Only an anonymous refusal is reported as "Discogs now requires credentials" | `discogs.rs` · `only_an_anonymous_refusal_counts_as_denied` |
| Settings stores, hides and removes either form, and says so when the Keychain will not answer | `SettingsView.test.tsx` · `SettingsView · Discogs` |

## Keeping this honest

- **`finalize` has no end-to-end test** — `apply_cover`, `prepare_cover` and the
  field mapping do, against a real file in a temporary folder, and `artwork.rs`
  now covers `process_cover` and `already_cdj_shaped`. What is still untested is
  `finalize` itself, top to bottom; it is in [TODO.md](../TODO.md). This is the
  code that rewrites the user's files, so a change here earns a real file rather
  than only a unit test.
- **The thumbnail cache states what invalidates it**, like every other cache
  here: a thumbnail is valid until the file behind it is written.
  `src/lib/coverCache.ts` holds the rule, and `forgetCoverThumbs` is called for
  a tag write, an undo, a conversion, and a file the scan really re-probed
  (`scan://tracks` names those in `fresh`; the same batch also carries rows it
  reused unchanged, and forgetting those would re-decode a thumbnail per visible
  row on every scan). Anything new that rewrites a file has to call it too.
- A new metadata field touches `TrackMetadata`, the `ItemKey` list in
  `finalize`, the schema and `TRACK_COLUMNS`, the editors, and — if it should be
  required — `is_complete`. The column has to go at the end of the schema; see
  [SCANNING.md](SCANNING.md).
