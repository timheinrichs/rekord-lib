# rekord-lib

Desktop app (Tauri 2 + React 19 + Tailwind v4) that prepares audio files for
CDJ/XDJ and Rekordbox compatibility (conversion, metadata, duplicate detection,
Bandcamp download).

- Frontend: `src/` (Vite). Rust backend: `src-tauri/src/`.
- Dev/build run on **Node 22** (`.nvmrc`) — in the terminal, run `nvm use` if needed.

## Design & Branding — mandatory

The app has a **fixed visual identity**. All UI work follows the
styleguide, not ad-hoc design:

- **Single source of truth:** `src/styles/tokens.css` (Tailwind v4, CSS-first).
  Full styleguide: [`docs/brand/STYLEGUIDE.md`](docs/brand/STYLEGUIDE.md).
  Tokens are also available as TS: `src/styles/theme.ts` (for canvas/charts).
- **Colors only via tokens**, never the Tailwind default palettes
  (`neutral-*`, `sky-*`, `emerald-*`, …):
  - Surfaces/text/lines: semantic tokens `bg-bg`, `bg-surface`,
    `bg-surface-2`, `text-fg`, `text-fg-muted`, `text-fg-subtle`,
    `border-border`, `border-border-strong` (switch dark/light automatically).
  - Brand/action/progress: **accent violet** `accent-*`
    (primary `bg-accent-600`, hover `accent-500`).
  - Status = **compatibility** (semantic only, never decorative):
    compatible/done → `success`, conversion needed / metadata
    incomplete / warning → `warning`, error/delete/incompatible →
    `danger`.
- **Typography:** `font-mono` (JetBrains Mono) for data/labels/values/buttons
  (filenames, `44.1 kHz`, `24-bit`, format tags) — mono is deliberately prominent.
  `font-sans` (Inter) only for longer descriptive/help text. Sentence case,
  no Title Case / ALL CAPS. Weights only 400/500.
- **Shape:** controls `rounded-md`, cards `rounded-lg`, pills `rounded-full`.
  Border = hairline `border border-border`. Depth via `surface` levels, not
  via shadows. No gradients/glow, **one** accent.
- **Dark is the default** (`<html data-theme="dark">`).
- **Logo/icons:** `src/assets/brand/`, app icons `src-tauri/icons/`,
  web favicons `public/`. Never distort/recolor the logo or add effects.

In short: build new UI so that it does not stand out next to the existing UI — use
tokens, status color = state, mono for technical data. When in doubt, check
`docs/brand/STYLEGUIDE.md`.

## Workflow

- After non-trivial changes: `npx tsc --noEmit` (frontend) and
  `cd src-tauri && cargo check` (backend) must be green.
- Commit/PR conventions as in the existing history (Conventional Commits).

## Testing — mandatory

- **Every new feature or change ships with matching tests.** Cover the new
  logic, not just the happy path (edge cases, empty/invalid input).
  - Frontend: Vitest + Testing Library. Test files live next to the code as
    `*.test.ts(x)`. Run with `npm test` (watch: `npm run test:watch`,
    coverage: `npm run test:coverage`).
  - Backend: Rust unit tests in a `#[cfg(test)] mod tests` next to the code.
    Run with `cd src-tauri && cargo test`.
- Keep new logic **testable**: put pure logic in `src/lib/` (frontend) or a
  dedicated `mod`/function (backend) instead of burying it in large components
  or Tauri commands. Extract if needed (see `src/lib/grouping.ts`).
- Before finishing, in addition to `tsc --noEmit` / `cargo check`, both
  **`npm test`** and **`cd src-tauri && cargo test`** must be green. CI
  (`.github/workflows/ci.yml`) enforces this on every push/PR.
