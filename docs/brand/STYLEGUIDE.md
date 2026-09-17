# rekord-lib — Brand & setup

The logo, the brand assets, and how a checkout is wired up to render them.

> **The visual system lives in [`DESIGN.md`](../../DESIGN.md)** — colours,
> typography, layout, depth, shape, components, motion and the named rules that
> govern them, with `src/styles/tokens.css` as their implementation. This file
> holds only what that document does not: the marks themselves, and the two
> pieces of setup the project needs to look right. Each fact belongs to exactly
> one of the two.
>
> It used to hold both, and the copies drifted: by 0.9.0 this document described
> a type scale the app never used, opaque status tokens nothing referenced, and
> a control radius ten fields ignored — one of which was hiding a real defect.
> That is why there is now one home per fact.

---

## 1. Brand in one sentence

`rekord-lib` prepares audio files so that they run without errors on Pioneer
CDJ/XDJ. The brand's tone is **technical, precise, calm** — a
tool for DJs, not a playful consumer product. This is reflected in
monospace type, a dark surface, and a single strong accent.

---

## 2. Logo

### Structure
Square brackets `[ ]` (= code library, the `-lib`) enclose a
waveform of four bars (= audio). Two-tone: `rekord` in the foreground color,
`-lib` and the waveform in accent violet.

### Files (`src/assets/brand/`)
| File | Use |
|---|---|
| `rekord-lib-mark.svg` | Mark only, colored, transparent |
| `rekord-lib-mark-mono.svg` | Mark single-color (`currentColor`) — inherits text color |
| `rekord-lib-logo-horizontal.svg` | Wordmark, light backgrounds |
| `rekord-lib-logo-horizontal-dark.svg` | Wordmark, dark backgrounds |
| `rekord-lib-logo-stacked.svg` / `-dark.svg` | Stacked (square surfaces) |
| `rekord-lib-app-icon.svg` | Squircle app icon (source of all raster icons) |

The wordmark is converted to paths — the SVGs render identically everywhere,
even without the font installed.

Raster icons are generated from `rekord-lib-app-icon.svg` and live where the
platform expects them, not next to the sources: macOS app icons in
`src-tauri/icons/`, web favicons and the touch icon in `public/`.

### Rules
- **Clear space:** keep at least the height of a bracket foot (≈ 1/6 of the mark height) clear all around.
- **Minimum size:** mark from 24 px, wordmark from 120 px wide.
- **Color choice:** on light surfaces the standard variant, on dark surfaces the `-dark` variant.
- **Don't:** distort, swap colors, add effects/shadows, or separate the brackets and waveform.
- For very small UI (16–20 px, e.g. menubar) use `rekord-lib-mark-mono.svg`; the waveform visually merges there, which is acceptable.

---

## 3. Setup

Two mechanics a checkout needs. Everything else about type and colour is in
[`DESIGN.md`](../../DESIGN.md).

### Fonts

Both faces are installed as packages rather than linked, so the app renders
offline and identically on every machine:

```sh
npm i @fontsource/inter @fontsource/jetbrains-mono
```

```ts
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
```

These four lines are in `src/main.tsx`. The weights are the ones the UI uses and
no more — see the two-weights rule in `DESIGN.md`.

### Theme

Dark is the default. Toggle via the attribute on `<html>`:

```html
<html data-theme="dark">   <!-- or "light" -->
```

All semantic tokens (`bg`, `surface`, `fg`, …) and status surfaces switch
automatically. The ramps (`accent-*`, `graphite-*`) are fixed across themes —
which is why surfaces and text take the semantic tokens, never the ramps.
