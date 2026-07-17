# rekord-lib

Desktop-App (Tauri + React), die Audiodateien so aufbereitet, dass sie **ohne
Error-Codes (v. a. E-8305) auf allen Pioneer CDJ/XDJ** laufen und sauber mit
**Rekordbox** kompatibel sind.

## Funktionen

- **Format-Konvertierung** in ein wählbares Zielformat (Default: **AIFF**),
  inkl. automatischer Korrektur inkompatibler Eigenschaften:
  - Resampling >48 kHz → 44,1 kHz
  - unkomprimiertes PCM (kein AIFF-C), 16-/24-bit
  - Warnung bei FLAC/ALAC (nur neuere Player CDJ-3000/NXS2)
- **Metadaten** mit Vorschlägen bei fehlenden Feldern *(Phase 2, in Arbeit)*
- **Bandcamp**-Download gekaufter Musik *(Phase 3, geplant)*

## Voraussetzungen

- **Node.js ≥ 20.19** (Vite 7). Das Projekt enthält eine `.nvmrc`:
  ```sh
  nvm use
  ```
- Rust (stable) + Tauri-Voraussetzungen für macOS.
- Der ffmpeg/ffprobe-Sidecar liegt in `src-tauri/binaries/`
  (`ffmpeg-aarch64-apple-darwin`, `ffprobe-aarch64-apple-darwin`).

  > **Hinweis für Release-Builds:** Die aktuell eingelegten Binaries stammen aus
  > Homebrew und referenzieren Homebrew-dylibs — sie laufen nur auf einem
  > Rechner mit installiertem Homebrew-ffmpeg. Für ein verteilbares App-Bundle
  > müssen sie durch **statische** macOS-Builds (z. B. von evermeet.cx) ersetzt
  > werden.

## Entwicklung

```sh
nvm use
npm install
npm run tauri dev
```

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
