# Changelog

All notable changes to rekord-lib are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/)
(`MAJOR.MINOR.PATCH`). As long as the version is at `0.x`, MINOR bumps may
contain incompatible changes.

## [Unreleased]

### Fixed
- **The expand chevron is back.** Moving it into a column of its own left it in a
  cell whose padding used up the entire width, so it rendered into nothing.
- **The checkboxes line up in every view.** In the folder and label views a
  nested track's checkbox was pushed right along with its title, out of line with
  the group rows above it — and two levels deep it left its column altogether and
  disappeared. Nesting is now shown where it belongs, in the title column, so one
  glance down the list shows the hierarchy and the checkboxes form a straight
  line.
- **A steady tone no longer gets a confident wrong tempo.** A file with no
  transients at all — a drone, a test tone — has no tempo, but the detector used
  to normalise a flat onset curve by its own numerical noise and report a
  confident number, which the scan then wrote into the file. It now says nothing,
  which is what it says for silence and noise already.
- **Every launch no longer re-analyses the whole library.** The start-up sync
  compared the folder against a track list React had not re-rendered yet, so on
  an unlucky run every stored track looked new — and files deleted outside the
  app were never noticed as gone.
- **A brand-new library gets its tempos on the first run.** Detection is handed
  the list of files a sync just produced instead of reading a list that React
  had not re-rendered yet, which on a fresh library meant nothing looked to be
  missing a tempo and no detection started at all — it only began on the second
  launch. Timing-dependent, so it did not fail every time.

### Changed
- **The library columns are in a more useful order** and the expand arrow has a
  column of its own, so the title column shows nesting on its own and the rows
  line up with the group headers above them in every view.
- **The scan button says what it is detecting.** A run over a fresh library reads
  "BPM/Key", one that only needs keys reads "Key" — the analysis decodes each
  file once and produces whichever of the two is missing, and the label now says
  which.
- **Tempos keep their decimals.** Detection used to round to a whole number and
  throw the rest away — on a real collection nearly half of all tempos are not
  integers, and Rekordbox stores them that way too. A detected tempo now travels
  as a fractional value into the file's tag ("127.60", Rekordbox' own format) and
  into the library.
- **A tempo the app is unsure about is no longer written into your files.** The
  detector reports how convinced it was; below the threshold the value still
  appears in the library, marked, and the metadata editor says how sure it was
  and that the file was left alone. A wrong number in a thousand files is worse
  than no number — and the threshold was picked by measuring what each setting
  prevents against what it costs, not by taste.
- **Tempos are shown as whole beats** — "128", not "127.61" — because that is
  what a DJ reads and what other DJ software displays. The decimals live in the
  file and the library, not in the columns. The metadata editor still accepts a
  decimal if you type one (comma included), and a tempo field you did not touch
  keeps its stored value, so editing an album's genre no longer rounds every
  tempo in it.

### Added
- **The library list shows each track's waveform.** Drawn from the baseline up
  rather than mirrored around a centre line, which doubles the detail in a row
  that tall — enough to see where the intro ends. It comes from what the scan
  stored, so scrolling does not compute anything.
- **Choose which columns the library shows.** A new button left of the filter
  lists them; everything is on by default, and the choice is remembered. The
  columns that carry selection and hierarchy are not offered — a list you cannot
  select in is broken, not customised.
- **Beat positions, not just tempo.** The analysis works out where the beats sit,
  which is what a waveform needs before it can show them. Measured against
  Rekordbox' own grids, the median error is 0.035 of a beat — 16 ms at 128 BPM.
- **Filter by key.** The filter menu lists the keys present in the library in
  Camelot order — 1A, 1B, 2A … — so neighbours on the wheel are neighbours in
  the menu and picking two mixable keys means picking two adjacent entries.
- **Tracks get a musical key.** Detected during the scan and shown in the library
  table and the metadata editor, as both the name and its Camelot number
  ("Am · 8A"), with how sure the detector was next to it.

  It stays in the library and is **never written into your files**. Measured
  against 2180 Rekordbox keys, the best detector available — ours, ahead of the
  off-the-shelf one — agrees about a third of the time, and a wrong key written
  into a file is read by every other program and outlives the guess. In the
  library it is simply replaced when the detector improves. The confidence is
  shown as a number rather than hidden behind a threshold because it means
  something: agreement climbs from 32 % at the bottom of the range to 71 % at the
  top, and no cut-off is both reliable and covers a whole collection.
- **Waveforms are computed once and kept.** The scan stores each track's
  waveform, so it is there instantly wherever it is shown instead of being
  recomputed. About 11 MB for a 2200-track library, and it costs the scan the
  difference between reading two minutes of a file and reading all of it, because
  the analysis was decoding it anyway.
- **The player bar shows a waveform.** The progress line is now the track's
  shape, with the played part filled in — enough to see where the intro ends and
  the drop starts, and to click straight to it. It appears a moment after
  playback begins, because it is computed from the whole file rather than
  guessed, and the plain line stands in until then.
- `scripts/dev-library.py` and `scripts/dev-app.sh` — a generated audio library
  for development plus a one-command way to run the app against it in its own
  app data directory. Development no longer touches a real collection, and each
  generated file covers one case the app has to get right, with the expected
  result known by construction.
- **The tempo range is selectable** (Settings → Analysis). Six presets: the
  familiar wide 60–200 stays the default, plus five that span exactly one octave
  — within one octave every tempo has a single representative, so half/double
  time has one answer instead of two. Worth trying if your library sits in one
  genre; measured on a broad one it makes no difference, and a range that
  excludes a track's real tempo leaves it with none at all. "Re-detect BPM" is
  what applies a change to files that already carry a tempo.
- `docs/DSP_BENCHMARK.md` — the tempo and key detection of `stratum-dsp` measured
  against ours over 2176 tracks with Rekordbox reference values, with the
  decision it produced: ours stays. It is right within ±2 BPM on 87.1 % of
  tracks with a steady reference grid against the crate's 83.1 %, at 30 ms of
  analysis against 2087 ms — and the crate gets worse, not better, when given
  the whole track it is designed for. Its key detection reaches 29.6 % exact
  where its own README claims 72.1 %, so buying key detection is off the table.
- `scripts/rekordbox-reference.py` plus `src-tauri/tests/data/bpm_reference.csv`
  — a Rekordbox XML export reduced to 2180 reference tempos, grid drift values
  and keys. Filenames are hashed, so the committed file says nothing about which
  music the collection holds, and the benchmark matches by hashing what it finds
  on disk. `src-tauri/tests/dsp_bench.rs` runs the comparison; its scoring logic
  is covered by unit tests that need no audio, so CI checks it on every push.

## [0.5.0] - 2026-08-20

### Added
- **A scan can be paused.** The scan button doubles as the control: while a run
  is on it shows what the run is doing, and offers "Pause scan" when you point
  at it; held, it reads "Paused" and offers "Resume scan". Whatever is being
  analysed at that moment still finishes, so pausing never costs a file its
  analysis, and the run picks up where it left off. Useful when the machine is
  needed for something else — a full library takes minutes.
- **Files the analysis could not use are named.** A broken or unreadable file
  was always skipped rather than aborting the run, but it disappeared without a
  word. A count in the header now opens the list, with the full path and the
  reason each file gave, and the list copies as text.
- **An event log**, behind a button in the header. It collects the problems the
  app worked around and used to keep to itself: a cache it could not read, rows
  it could not store, an undo entry it could not write, a tempo it detected but
  could not save. It survives a restart, marks unread warnings and errors with a
  dot, and copies as text — which is the form a bug report needs.
- **The bundled audio tools are checked at startup.** If ffmpeg or ffprobe
  cannot run on your machine, the app says so in one banner instead of letting
  every analysis and conversion fail for reasons you cannot see.
- `docs/CDJ_TEST_MATRIX.md` — where hardware-validated CDJ compatibility results
  go, with the scenarios to cover and what a row has to record. AIFF 16- and
  24-bit are recorded as playing on a CDJ-2000nexus, a CDJ-3000 and an XDJ-700
  with covers and tags intact; the resampling and AIFF-C cases the app exists
  for are still untested on hardware, and the file says which.
- `docs/FUTURE_CONSIDERATIONS.md` — the roadmap, from the comparison with a
  comparable open-source project.

### Changed
- **Undo survives a restart.** The undo history for tag writes moved into the
  database, and the snapshot is taken from what is really in the files rather
  than from what the list happened to be showing. The last 20 writes stay
  undoable, each labelled with what it was — a filename, a bulk edit, a batch of
  pending edits.
- **Undoing an artwork change puts the old artwork back.** It used to restore
  the text fields and leave the new cover in place, because the snapshot did not
  cover it.
- **Converting with "replace original" moves the original to the trash** instead
  of deleting it outright. Every other delete in the app already did.
- **A library folder that is gone is treated as gone, not as empty.** Renaming
  it, moving it or unmounting the drive used to look like a mass deletion: the
  next scan quietly forgot every track, and the edits and analysis attached to
  them went too. Now nothing is dropped, and the library view offers to point
  the app at the folder's new location — every track that is really there keeps
  its identity, its pending edits and its fingerprint. Choosing a different
  folder in the settings does the same.

### Fixed
- **"No cover" now actually removes the artwork.** Choosing it and confirming
  left the picture in the file untouched, so the change looked like it had not
  been saved.
- **Files that are not really audio stay out of the library.** ffprobe
  recognises a file by its extension as readily as by its contents, so a
  damaged file could come back as a track with no sample rate and no channels —
  one that could never be played or converted. It is skipped and named now.
- **The reason a file was skipped is readable.** It used to be an exit code and
  an empty line; it is what the tool actually reported, e.g. "Invalid data found
  when processing input".

## [0.4.9] - 2026-08-19

### Changed
- **Rescanning is fast now.** The library moved from a JSON file into a database,
  and a scan reuses what it already knows about every file whose size and
  modification time are unchanged — so it only re-reads what actually changed.
  Measured on a 2225-track library, a full rescan went from about four minutes to
  seconds. The files that do need reading are probed eight at a time instead of
  one after another. A rescan also picks up files you re-tagged outside the app,
  which it never used to notice.
- **The duplicate search is part of the scan.** It no longer needs starting: it
  runs at the end of every scan that changed something, and its acoustic
  fingerprints are kept, so a repeat search decodes nothing. On the same library
  the second run reused 2147 fingerprints and computed none. A tempo-only
  background pass does not trigger it — tempo is not something the matching
  looks at.
- **"Find duplicates" is now "Duplicates (n)"** and only appears when there are
  any. It opens the panel; the panel no longer opens itself when a search
  finishes, since nothing you did asked for that search. "Search again" is gone
  with it — the scan button is the one way in.
- **The scan button** reads "Scan library", has a scanner icon rather than a
  reload arrow, and confirms a finished run for a moment with a check in green.
- Groups you mark as **"not a duplicate" stay dismissed** across searches. They
  used to only disappear from the current result, which was enough while the
  search was manual and would have handed every one of them back now that it
  runs on its own.
- Saving is **incremental**: a single metadata edit writes one row instead of
  rewriting a multi-megabyte file. During a scan that rewriting had been growing
  the app by around 130 MB per minute and slowing down the very run it was
  recording.
- **Disabled buttons all look the same now.** The greyed-out state was drawn with
  transparency in three different strengths, which came out as a different grey
  on every kind of button — and made the same scan step look lighter in one pass
  than in the next. It is a defined colour instead.

### Fixed
- **Dialogs opened off-screen.** The metadata editor, bulk edit and the
  duplicates panel centred themselves on the whole track list rather than on the
  window, so on a long library they opened far below what you were looking at and
  had to be scrolled to. Back to top was misplaced for the same reason.
- **Background listeners could pile up**, one per library-folder switch, each
  still reacting to events for a screen that no longer existed.

### Note
The first scan after updating re-reads every file once. A new version may analyse
differently than the one that filled the cache, and a file's size and timestamp
cannot show that — so the cache is retired on a version change. Every scan after
that one is fast again.

## [0.4.8] - 2026-08-08

### Added
- **Filter menu**: a funnel button next to the grouping switch filters the
  library by BPM range, genre, year range, conversion need, metadata
  completeness and origin (Bandcamp or local). A dot on the button marks that
  something is filtered, and each active facet appears as a chip next to the
  button that can be removed on its own.
- **Start-up screen**: the app now shows its logo with the four bars moving
  while it boots, and says what it is doing underneath ("Loading library",
  "Analyzing 12/2223"). It replaces a blank window followed by a flash of the
  "no music in the library yet" empty state.
- **Skeleton loading**: the track table, the Bandcamp collection, cover
  thumbnails, the metadata editor's cover and the duplicate search show the
  shape of what is loading instead of a line of text. Switching views, filters
  or sorting fades rather than jumps. All of it is disabled when the system asks
  for reduced motion.
- Shipped builds carry a **Beta** chip in the header and on the start-up screen.

### Changed
- **Status is now a column of icons** behind "Downloaded" rather than text
  badges in the middle of the table, which gives the title, artist and album
  columns 8rem more room. The explanation is in the tooltip; conversion progress
  shows as a spinner with its percentage.
- **Grouping switch** reads Album / Label / Folder / Flat, in that order. The
  track count sits beside it, and the filter chips moved across to the filter
  button they belong to.
- Search now looks through unsaved metadata edits as well, and covers genre and
  year.
- Expand/collapse all is gone for the moment; per-group chevrons are unchanged.

### Fixed
- **Single-track albums were pulled out of their album**: a single or one-track
  EP rendered as a loose row next to the albums it belongs with, because
  grouping only started at two tracks. A lone track that carries a real album
  tag now gets its group; tracks with no album tag stay loose, so a stray file
  does not get a group named after whatever folder it sits in. Applies to the
  label view too, which carried its own copy of the rule.
- **Row heights could land on the wrong row** after a filter, sort or grouping
  change: the virtualizer keys measured heights by position over a list that
  mixes group headers and track rows, so index *i* could be a header where a
  track row had been measured. Heights are now discarded when the list is
  recomposed.
- The filter chips' outline was clipped along its top and bottom edge.

## [0.4.7] - 2026-08-08

### Added
- **BPM**: tracks are analysed during the scan and the tempo is written into the
  file (ID3 `TBPM`, MP4 `tmpo`, Vorbis `BPM`), so Rekordbox picks it up on
  import. An existing BPM tag always wins and is never overwritten, and an
  unconvincing detection stores nothing rather than a guess. New sortable BPM
  column, group headers show the range, and the metadata editor lets you correct
  a value by clicking it. Can be switched off under *Settings → Analysis*, which
  also offers a re-run over the whole library after a detector improvement.
- **Grouping by label**: a fourth mode next to Flat / By album / By folder,
  nested label → album → tracks. Labels are searchable.

### Fixed
- **Duplicate detection compared corrupted audio**: raw PCM piped out of the
  ffmpeg sidecar was read line by line, which re-appended newlines and shifted
  the 16-bit sample alignment — a 120 s excerpt came out 11,286 samples too
  long. Fingerprints have been computed from noise all along. **Existing
  duplicate results should be regenerated.**
- **Conversion dropped metadata**: ffmpeg's AIFF muxer keeps little more than
  the title, and the tags were only re-applied when an edit was pending, so a
  plain conversion silently lost artist, album, label and BPM.
- **Scan results are no longer lost on cancel**: they stream in as they are
  produced instead of arriving only at the end, so stopping or quitting costs at
  most one batch. The scan no longer blocks converting or the duplicate search
  while the (long) BPM pass runs.

### Changed
- **Large libraries render far faster**: only the visible rows of the track
  table are in the DOM, which removes the stutter when switching views.
- Full sweep, incremental catch-up and BPM backlog are one background job with
  one progress indicator instead of separate scans.

## [0.4.6] - 2026-08-01

### Fixed
- **Bandcamp cover images load again**: the strict CSP shipped in 0.4.5 blocked
  the Bandcamp collection's cover thumbnails (served from the bcbits CDN). Allow
  `https://*.bcbits.com` in `img-src`; a test now keeps the CSP in sync with the
  art host.

## [0.4.5] - 2026-07-30

### Fixed
- **Sidecars run without Homebrew**: the bundled `ffmpeg`/`ffprobe` were
  dynamically linked against Homebrew dylibs and crashed with
  `dyld: Library not loaded` on machines without an identical Homebrew install —
  imports failed and Bandcamp downloads never appeared in the library. Replaced
  with self-contained static builds (system libraries only).

### Changed
- **Easier install**: the app bundle is now ad-hoc signed, so Gatekeeper shows
  the bypassable "unidentified developer" prompt instead of the hard
  "is damaged and can't be opened" error on first launch.
- **Hardened webview**: added a strict Content-Security-Policy and narrowed the
  asset-protocol scope from the whole filesystem to the user's home and mounted
  volumes.

### Added
- `scripts/build-static-ffmpeg.sh` + a manual GitHub workflow to regenerate
  minimal, audio-only static sidecars from pinned, checksum-verified sources, and
  a test (`sidecars_are_self_contained`) that fails the build if a sidecar ever
  links against non-system libraries again.

## [0.4.4] - 2026-07-23

### Added
- **Audio player**: hovering a cover reveals a play button; clicking it plays the
  track (queuing the current list for next/prev) or the whole album. Hovering the
  active track's/album's cover shows a pause button. A bottom bar shows the cover,
  title and artist with play/pause, previous/next, a seek bar, "Track x/y" (for
  album playback) and a close button. Files stream via Tauri's asset protocol.

## [0.4.3] - 2026-07-23

### Added
- **Undo** for tag writes: every metadata write now snapshots the previous
  on-disk values first, and an "Undo" header action reverts the last write
  (single edit, bulk, folder or flush). Emptying a field now also clears the tag
  on disk, so an undo faithfully restores a field that used to be empty.
- **Write pending tags**: a header action appears when there are metadata edits
  made earlier that were never written to disk (they only lived as pending edits
  before tags were saved on edit). One click writes them all into the files.
- **Folder view**: a new grouping mode (Flat / By album / **By folder**) shows the
  library as its real directory tree with collapsible folders. Each folder can be
  bulk-edited (e.g. give a loose collection of singles/EPs a common album tag),
  selected, or deleted as a whole — handy for tidying up many small entries.

### Changed
- Metadata edits (single **and** bulk) are now **written straight into the files**
  via lofty and re-analyzed in place, instead of only being applied on
  conversion. So a tag change (e.g. album) is present on disk immediately — also
  for Rekordbox — without needing to convert.
- The release **year** is now optional for metadata completeness. A track/album
  counts as "Metadata incomplete" only when title, artist, album or album artist
  is missing (genre, year, catalog number, label and country stay optional).

## [0.4.2] - 2026-07-22

### Changed
- Library row actions (Edit/Delete/Convert) now appear as a right-aligned
  overlay only on row hover with a transparent column background (no longer
  covering the Downloaded column), and the table is narrower so it fits at full
  window width without horizontal scrolling.

### Fixed
- Deletions no longer play the macOS "move to trash" sound, and deleting an
  album trashes its whole folder (incl. artwork) in one step when it holds only
  that album.
- **Bandcamp sync** no longer re-downloads purchases it already has: presence is
  now confirmed via a persistent download ledger (what each download actually
  wrote) in addition to metadata matching. Matching also keeps non-Latin (e.g.
  Cyrillic) titles instead of erasing them and, since downloads are named after
  the purchase, recognizes an album by its extracted folder name or a single
  track by its file name even when the tags are missing or odd (e.g. a
  "Various"-tagged compilation). A successful download is authoritative — the
  purchase counts as present immediately, even before its files are re-scanned
  — and deleting files forgets them from the ledger so the purchase can be
  synced again. This fixes the wrong "missing" count and the endless re-download
  of tracks/albums already in the library.

## [0.4.1] - 2026-07-22

### Added
- Album rows now carry the **Bandcamp** origin badge when any of their tracks
  came from a Bandcamp download, matching the per-track badge.

### Changed
- Track and album row actions (Convert / Edit / Delete) now appear in a
  right-aligned overlay that fades in only on row hover, keeping idle rows clean.

### Fixed
- After a conversion the row now refreshes on its own — status (e.g. "Convert"),
  format and length update immediately without a manual rescan, including
  in-place conversions (resample / bit-depth change) that keep the same path.

## [0.4.0] - 2026-07-21

### Added
- **Stronger duplicate detection**: metadata-based matching (artist + normalized
  core title + length) that also catches tracks whose titles were mangled by a
  foreign convert; a new **album-duplicate view** to keep one version and delete
  the others in one action, with now-empty album folders cleaned up.
- **Dedicated Bandcamp page**: the full purchased collection is shown
  persistently (cached, refreshed in the background) with **Download all**,
  **Sync library** (only what's missing locally) and per-item downloads.
- **Navigation**: Library and Bandcamp as header tabs; settings closes with an
  X icon.
- **Download format** setting for Bandcamp downloads (default AIFF).
- **Metadata dialog**: wider, a read-only Path field with **Open in Finder**,
  and a Format / Length / Status details block.
- **Window state**: the app remembers its size/position across restarts.
- Hover **marquee** for long titles/albums; friendlier format labels
  (e.g. "AIFF 24-bit" instead of PCM_S16BE).

### Changed
- Genre is no longer required for the "metadata incomplete" check; the green
  "Compatible" badge was removed (only files needing conversion are flagged).

## [0.3.3] - 2026-07-21

Maintenance release — confirms the fully automatic release/publish pipeline
(immutable releases disabled, `releaseDraft: false`). No functional changes.

## [0.3.2] - 2026-07-21

Maintenance release — first published GitHub Release, used to validate the
end-to-end auto-update flow (no functional changes over 0.3.0; supersedes the
unpublished 0.3.1, whose release build could not attach assets to an immutable
release).

## [0.3.0] - 2026-07-21

First production release: installable macOS app that keeps itself up to date.

### Added
- **Catalog number** and **label** metadata fields (optional), editable in the
  single and bulk metadata editors; the label is picked up automatically from
  Bandcamp downloads via embedded tags.
- **Sortable track list**: sort the top level (collapsed albums + single
  tracks) by clicking the Title / Artist / Album / Length column headers; tracks
  within an album stay ordered by track number. Album group rows now show the
  album artist.
- **Self-update**: the app checks for a newer release on start, shows an
  indicator on the settings gear, and installs updates from **Settings → About**
  (download progress + restart).
- **About section** in the settings with the app version and a link to the
  third-party licenses.
- **Automated releases** via GitHub Actions (signed macOS build + updater
  artifacts + `latest.json` on tag push).
- **Test suite**: Rust unit tests and a Vitest + Testing Library frontend suite,
  plus a CI workflow (typecheck, tests) on every push/PR.
- **Licensing**: MIT `LICENSE` and `THIRD_PARTY_LICENSES.md` (incl. FFmpeg).

## [0.2.0] - 2026-07-19

First complete feature release: the scaffold has grown into a usable
tool for a CDJ/XDJ- and Rekordbox-compatible library.

### Added
- **Managed library**: central library folder, recursive scan with
  animated progress (cancelable), persistent track database (the list is
  available immediately at startup, refreshed by a background scan).
- **Format conversion** to a selectable target format (default AIFF) including
  resampling > 48 kHz → 44.1 kHz, PCM 16/24-bit, FLAC/ALAC warning. Converted
  files land in the source's folder; the original is replaced on format
  change. Drag-and-drop import of external files.
- **Metadata editor** with suggestions from filename/MusicBrainz and from
  existing library values (datalist); required fields title/artist; cover from
  file/MusicBrainz. **Bulk edit** for multiple tracks.
- **Cover**: embedded covers as thumbnails; fallback to a cover image in the
  folder (`cover.jpg` …), which is automatically embedded on conversion.
- **Duplicate detection** across formats/filenames: length + acoustic fingerprint
  (Chromaprint) + name similarity; results are persistent, can be deleted
  individually or in bulk (trash), groups can be dismissed; cancelable
  background job.
- **Bandcamp**: login, sync of the purchased collection, streamed download
  with progress and a downloads overlay in the header.
- **List**: full width with a minimum width + horizontal scroll, cover column,
  filters (to convert / metadata incomplete) + search, album grouping
  (collapsible), multi-select including shift range, row click opens
  the editor, back-to-top, sticky header.
- **Branding**: visual identity (logo, app icons, color/typography tokens, dark
  as the default). Styleguide anchored in `docs/brand/STYLEGUIDE.md` and in
  `CLAUDE.md`.

### Changed
- Rebuilt the app around the managed library (instead of a single-file flow).
- Scan and duplicate detection run as cancelable background singletons
  (survive reloads, no double start).

## [0.1.0] - 2026-07-17

- Project scaffold: Tauri 2 + React 19 + Tailwind v4, bundled
  ffmpeg/ffprobe sidecar, first analysis/conversion pipeline.

[Unreleased]: https://github.com/timheinrichs/rekord-lib/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/timheinrichs/rekord-lib/compare/v0.4.9...v0.5.0
[0.4.9]: https://github.com/timheinrichs/rekord-lib/compare/v0.4.8...v0.4.9
[0.4.8]: https://github.com/timheinrichs/rekord-lib/compare/v0.4.7...v0.4.8
[0.4.7]: https://github.com/timheinrichs/rekord-lib/compare/v0.4.6...v0.4.7
[0.4.6]: https://github.com/timheinrichs/rekord-lib/compare/v0.4.5...v0.4.6
[0.4.5]: https://github.com/timheinrichs/rekord-lib/compare/v0.4.4...v0.4.5
[0.4.4]: https://github.com/timheinrichs/rekord-lib/compare/v0.4.3...v0.4.4
[0.4.3]: https://github.com/timheinrichs/rekord-lib/compare/v0.4.2...v0.4.3
[0.4.2]: https://github.com/timheinrichs/rekord-lib/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/timheinrichs/rekord-lib/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/timheinrichs/rekord-lib/compare/v0.3.3...v0.4.0
[0.3.3]: https://github.com/timheinrichs/rekord-lib/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/timheinrichs/rekord-lib/releases/tag/v0.3.2
