# Changelog

All notable changes to rekord-lib are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/)
(`MAJOR.MINOR.PATCH`). As long as the version is at `0.x`, MINOR bumps may
contain incompatible changes.

## [Unreleased]

### Changed
- Library row actions are now a right-aligned column frozen to the visible edge
  of the (wide) table, so Edit/Delete/Convert are always reachable on hover
  without scrolling horizontally.

### Fixed
- Deletions no longer play the macOS "move to trash" sound, and deleting an
  album trashes its whole folder (incl. artwork) in one step when it holds only
  that album.
- **Bandcamp sync** no longer re-downloads purchases it already has: presence is
  now confirmed via a persistent download ledger (what each download actually
  wrote) in addition to metadata matching. Matching also keeps non-Latin (e.g.
  Cyrillic) titles instead of erasing them, and falls back to the file name for
  untagged single-track downloads. This fixes the wrong "missing" count and the
  endless re-download of the same track.

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

[Unreleased]: https://example.com/rekord-lib/compare/v0.2.0...HEAD
[0.2.0]: https://example.com/rekord-lib/releases/tag/v0.2.0
[0.1.0]: https://example.com/rekord-lib/releases/tag/v0.1.0
