# rekord-lib

Desktop-App (Tauri 2 + React 19 + Tailwind v4), die Audiodateien CDJ/XDJ- und
Rekordbox-kompatibel aufbereitet (Konvertierung, Metadaten, Duplikatsuche,
Bandcamp-Download).

- Frontend: `src/` (Vite). Rust-Backend: `src-tauri/src/`.
- Dev/Build laufen auf **Node 22** (`.nvmrc`) — im Terminal ggf. `nvm use`.

## Design & Branding — verbindlich

Die App hat eine **feste visuelle Identität**. Bei jeder UI-Arbeit gilt der
Styleguide, nicht ad-hoc-Design:

- **Single source of truth:** `src/styles/tokens.css` (Tailwind v4, CSS-first).
  Voller Styleguide: [`docs/brand/STYLEGUIDE.md`](docs/brand/STYLEGUIDE.md).
  Tokens auch als TS: `src/styles/theme.ts` (für Canvas/Charts).
- **Farben nur über Tokens**, nie die Tailwind-Default-Paletten
  (`neutral-*`, `sky-*`, `emerald-*`, …):
  - Flächen/Text/Linien: semantische Tokens `bg-bg`, `bg-surface`,
    `bg-surface-2`, `text-fg`, `text-fg-muted`, `text-fg-subtle`,
    `border-border`, `border-border-strong` (schalten Dark/Light automatisch).
  - Marke/Aktion/Fortschritt: **Akzent-Violett** `accent-*`
    (primär `bg-accent-600`, Hover `accent-500`).
  - Status = **Kompatibilität** (nur semantisch, nie dekorativ):
    kompatibel/fertig → `success`, Konvertierung nötig / Metadaten
    unvollständig / Hinweis → `warning`, Fehler/Löschen/inkompatibel →
    `danger`.
- **Typografie:** `font-mono` (JetBrains Mono) für Daten/Labels/Werte/Buttons
  (Dateinamen, `44.1 kHz`, `24-bit`, Format-Tags) — mono ist bewusst prominent.
  `font-sans` (Inter) nur für längere Beschreibungs-/Hilfetexte. Sentence case,
  kein Title Case / ALL CAPS. Gewichte nur 400/500.
- **Form:** Controls `rounded-md`, Cards `rounded-lg`, Pills `rounded-full`.
  Border = Haarlinie `border border-border`. Tiefe über `surface`-Stufen, nicht
  über Schatten. Keine Gradients/Glow, **ein** Akzent.
- **Dark ist Default** (`<html data-theme="dark">`).
- **Logo/Icons:** `src/assets/brand/`, App-Icons `src-tauri/icons/`,
  Web-Favicons `public/`. Logo nie verzerren/einfärben/mit Effekten versehen.

Kurz: neue UI so bauen, dass sie neben der bestehenden nicht auffällt — Tokens
verwenden, Status-Farbe = Zustand, Mono für Technik. Im Zweifel in
`docs/brand/STYLEGUIDE.md` nachsehen.

## Workflow

- Nach nicht-trivialen Änderungen: `npx tsc --noEmit` (Frontend) und
  `cd src-tauri && cargo check` (Backend) müssen grün sein.
- Commit-/PR-Konventionen wie im bisherigen Verlauf (Conventional Commits).
