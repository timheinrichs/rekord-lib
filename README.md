# rekord-lib

Desktop app (Tauri 2 + React 19 + Tailwind v4) that prepares a music library so
that it runs **without error codes (especially E-8305) on all Pioneer
CDJ/XDJ** players and is cleanly compatible with **Rekordbox**.

## Features

- **Managed library** – central folder, recursive scan with progress
  (cancelable), persistent track database (the list is available immediately at startup).
- **Conversion** to a selectable target format (default **AIFF**) with
  automatic correction of incompatible properties:
  - Resampling > 48 kHz → 44.1 kHz
  - uncompressed PCM (no AIFF-C), 16-/24-bit
  - warning for FLAC/ALAC (only newer players CDJ-3000/NXS2)
  - output to the source folder, the original is replaced on format change;
    drag-and-drop import of external files
- **Metadata editor** with suggestions (filename, MusicBrainz, existing
  library values), required fields (title/artist), and **bulk edit**.
- **Cover** – embedded covers as thumbnails; fallback to a cover image
  in the folder (`cover.jpg` …), which is automatically embedded on conversion.
- **Duplicate detection** across formats/filenames (length + acoustic fingerprint
  + name similarity); results are preserved and can be deleted individually or in
  bulk (trash).
- **Bandcamp** – login, sync of the purchased collection, download with
  progress (downloads overlay in the header).
- **List** – filter + search, album grouping (collapsible),
  multi-select including shift range, sticky header, back-to-top.

Details on each version: see [CHANGELOG.md](CHANGELOG.md).

## Requirements

- **Node 22** (see `.nvmrc`):
  ```sh
  nvm use
  ```
- **Rust** (stable) + Tauri requirements for macOS.
- ffmpeg/ffprobe sidecar in `src-tauri/binaries/`
  (`ffmpeg-aarch64-apple-darwin`, `ffprobe-aarch64-apple-darwin`).

  > **Release builds:** The bundled binaries come from Homebrew and
  > reference Homebrew dylibs – they only run with Homebrew ffmpeg installed.
  > For a distributable bundle, replace them with **static** macOS builds
  > (e.g. evermeet.cx).

## Development

```sh
nvm use
npm install
npm run tauri dev
```

Before committing non-trivial changes:

```sh
npx tsc --noEmit                 # frontend types
cd src-tauri && cargo check      # Rust backend
npm run build                    # production bundle
```

## Build

```sh
npm run tauri build
```

## Project structure

```
src/                    React frontend (components, lib, tokens/styles)
src-tauri/src/          Rust backend
  audio/                probe, conversion, duplicates/fingerprint
  bandcamp/             login, collection, download
  metadata/             read/write tags, cover, suggestions
docs/brand/             styleguide + design tokens
```

## Versioning

- **Semantic Versioning** (`MAJOR.MINOR.PATCH`); changes in the
  [CHANGELOG.md](CHANGELOG.md) (Keep a Changelog).
- On release, keep the version in sync in **three places**:
  `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`
  (then `cargo check` for the `Cargo.lock`), then tag:
  ```sh
  git tag -a vX.Y.Z -m "vX.Y.Z"
  ```

## Design / Branding

Fixed visual identity – colors only via tokens (`src/styles/tokens.css`),
dark as the default. Authoritative styleguide: [docs/brand/STYLEGUIDE.md](docs/brand/STYLEGUIDE.md)
(short version in `CLAUDE.md`).

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
