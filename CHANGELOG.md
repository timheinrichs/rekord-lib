# Changelog

All notable changes to rekord-lib are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/)
(`MAJOR.MINOR.PATCH`). As long as the version is at `0.x`, MINOR bumps may
contain incompatible changes.

## [Unreleased]

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
