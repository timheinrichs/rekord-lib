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

## Install on macOS

Prebuilt for **Apple Silicon (M-series)**.

1. Download the latest `rekord-lib_x.y.z_aarch64.dmg` from the
   [Releases page](https://github.com/timheinrichs/rekord-lib/releases/latest).
2. Open the `.dmg` and drag **rekord-lib** into your *Applications* folder.
3. The app is **not signed with an Apple Developer certificate**, so on first
   launch macOS Gatekeeper will warn. Either **right-click the app → Open**
   (then confirm once), or clear the quarantine flag:
   ```sh
   xattr -dr com.apple.quarantine /Applications/rekord-lib.app
   ```

After that, the app **updates itself**: on start it checks for a newer release
and shows an indicator; install it any time from **Settings → About →
Install & restart**.

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
npm test                         # frontend unit tests (Vitest)
cd src-tauri && cargo check      # Rust backend
cd src-tauri && cargo test       # Rust unit tests
npm run build                    # production bundle
```

## Build

Local production build (Apple Silicon):

```sh
npm run tauri build -- --target aarch64-apple-darwin
```

The `.dmg` lands in `src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/`.
Self-updater artifacts (`*.app.tar.gz` + `.sig`) and `latest.json` are only
produced when the updater signing key is present (see below) — normally that
happens in CI, not locally.

## Project structure

```
src/                    React frontend (components, lib, tokens/styles)
src-tauri/src/          Rust backend
  audio/                probe, conversion, duplicates/fingerprint
  bandcamp/             login, collection, download
  metadata/             read/write tags, cover, suggestions
docs/brand/             styleguide + design tokens
```

## Versioning & releases

- **Semantic Versioning** (`MAJOR.MINOR.PATCH`); changes in the
  [CHANGELOG.md](CHANGELOG.md) (Keep a Changelog).
- Bump the version in sync in **three places**: `package.json`,
  `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (then `cargo check`
  updates `Cargo.lock`), add a CHANGELOG entry, commit.
- **Cut a release** by pushing a tag — this triggers
  `.github/workflows/release.yml`, which builds the `.dmg`, the self-updater
  artifacts and `latest.json`, publishes a GitHub Release and thereby makes the
  update available to installed apps — **fully automatic**.
  ```sh
  git tag -a vX.Y.Z -m "vX.Y.Z"
  git push origin vX.Y.Z
  ```
  This requires **"Immutable releases" to be OFF** (repo *Settings → General*).
  With it enabled, a published release becomes read-only before assets are
  attached and the upload fails; in that case set `releaseDraft: true` in the
  workflow and publish the draft manually instead.

### Updater signing (one-time setup)

The self-updater verifies releases with a minisign keypair.

1. Generate a keypair: `npm run tauri signer generate -- -w ~/.tauri/rekord-lib.key`
2. Put the **public key** into `src-tauri/tauri.conf.json`
   (`plugins.updater.pubkey`).
3. Add the **private key** and its password as repository secrets used by the
   release workflow: `TAURI_SIGNING_PRIVATE_KEY` and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Never commit the private key.

## License

rekord-lib is licensed under the **MIT License** (see [LICENSE](LICENSE)).

The distributed app bundles third-party components under their own licenses —
notably the **FFmpeg** binaries (LGPL/GPL), which are *not* covered by MIT. See
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).

## Design / Branding

Fixed visual identity – colors only via tokens (`src/styles/tokens.css`),
dark as the default. Authoritative styleguide: [docs/brand/STYLEGUIDE.md](docs/brand/STYLEGUIDE.md)
(short version in `CLAUDE.md`).

## Recommended IDE setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
