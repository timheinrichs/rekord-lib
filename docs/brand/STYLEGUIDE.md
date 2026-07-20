# rekord-lib — Styleguide

Visual identity and UI conventions for the desktop app (Tauri + React +
Tailwind). This file is deliberately written so that it can be handed to
**Claude Code**: it contains concrete tokens, class recipes, and rules.

> Short version for Claude Code: Use `tokens.css` (Tailwind v4) as the single
> source of truth. Dark mode is the default. The accent color is violet
> (`accent-*`). Logo/display text in `font-mono` (JetBrains Mono), body text
> in `font-sans` (Inter). Status colors are tied to app states (see
> below). No neon/gradient effects.

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

### Files (`/logo`)
| File | Use |
|---|---|
| `rekord-lib-mark.svg` | Mark only, colored, transparent |
| `rekord-lib-mark-mono.svg` | Mark single-color (`currentColor`) — inherits text color |
| `rekord-lib-logo-horizontal.svg` | Wordmark, light backgrounds |
| `rekord-lib-logo-horizontal-dark.svg` | Wordmark, dark backgrounds |
| `rekord-lib-logo-stacked.svg` / `-dark.svg` | Stacked (square surfaces) |
| `rekord-lib-app-icon.svg` | Squircle app icon (source of all raster icons) |
| `/logo/png/*` | Pre-rendered PNGs for README/docs |

The wordmark is converted to paths — the SVGs render identically everywhere,
even without the font installed.

### Rules
- **Clear space:** keep at least the height of a bracket foot (≈ 1/6 of the mark height) clear all around.
- **Minimum size:** mark from 24 px, wordmark from 120 px wide.
- **Color choice:** on light surfaces the standard variant, on dark surfaces the `-dark` variant.
- **Don't:** distort, swap colors, add effects/shadows, or separate the brackets and waveform.
- For very small UI (16–20 px, e.g. menubar) use `rekord-lib-mark-mono.svg`; the waveform visually merges there, which is acceptable.

---

## 3. Colors

Ramps are available in `tokens.css` as Tailwind utilities
(`bg-accent-500`, `text-graphite-300`, …).

### Accent — violet (brand)
`accent-500 #6A5FD6` is the base. Primary actions: `accent-600`, hover
`accent-500`. On dark, use `accent-300/400` for text/icons (contrast).

### Graphite — neutrals (dark-first)
`graphite-900 #100F14` app background → `graphite-0 #FFFFFF`. Cool-tuned
to match the violet.

### Semantic surface tokens (theme-dependent)
Don't use the ramps directly for surfaces/text; use these tokens instead — they
switch automatically between dark/light:

| Utility | Meaning |
|---|---|
| `bg-bg` | app background |
| `bg-surface` | panels, cards |
| `bg-surface-2` | raised surface (menu, popover, active row) |
| `border-border` / `border-border-strong` | dividers |
| `text-fg` | primary text |
| `text-fg-muted` | secondary text |
| `text-fg-subtle` | hints, placeholders |

### Status — tied to app states
This is the most important part for this app. Color encodes **compatibility**:

| State | Color | Example UI |
|---|---|---|
| **compatible / ready** | `success` (green) | "Runs on CDJ", checkmark |
| **conversion needed / warning** | `warning` (amber) | ">48 kHz → will be resampled", FLAC/ALAC only NXS2/3000 |
| **incompatible / error risk** | `danger` (red) | "E-8305 risk", "not PCM" |
| **brand / action / progress** | `accent` (violet) | convert button, waveform, progress |

Surfaces each use a `bg-*`/`fg-*` pair (in tokens.css): e.g. warning pill
`background: var(--bg-warning); color: var(--fg-warning)`.

---

## 4. Typography

| Role | Font | Use |
|---|---|---|
| Display / logo / labels / data | **JetBrains Mono** (`font-mono`) | filenames, kHz/bit, format tags, numbers, buttons |
| Body text / UI description | **Inter** (`font-sans`) | explanations, dialogs, help text |

Monospace is deliberately prominent — it suits the tool character and lets
technical values (`44.1 kHz`, `24-bit`, `AIFF`) align cleanly. Don't use it for
long body text.

**Scale** (Tailwind defaults): titles `text-xl`/`text-2xl` (500), body
`text-sm`/`text-base` (400), meta `text-xs` (`text-fg-subtle`). Two weights:
400 regular, 500 medium. No 600/700 in the UI. **Sentence case** everywhere,
no Title Case, no ALL CAPS.

Include the fonts (recommended):
```
npm i @fontsource/inter @fontsource/jetbrains-mono
```
```ts
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
```

---

## 5. Shape & layout

- **Radius:** controls `rounded-md` (8 px), cards `rounded-lg` (12 px), pills `rounded-full`. One-sided border accents (only `border-l`) → `rounded-none`.
- **Border:** default `border border-border` (hairline). No double frame + shadow on the same surface.
- **Elevation:** subtle, `shadow-md` for popover/dialog, otherwise flat. Depth comes from `surface` levels, not from shadows.
- **Density:** compact (power-user tool). Tight line height in lists, padding `px-3 py-2` for rows, `px-4 py-2.5` for buttons.
- **Icons:** stroke icons `stroke-width 2`, glyph 18–20 px. Place icon-only buttons in a **click target of at least 32 px** (`h-8 w-8`, centered), never just a bare glyph. Very small decorative icons (16 px) only without a click function.
- **Window:** dark title bar; if using a custom title bar, `bg-surface` + `border-b border-border`.

---

## 6. Component recipes (Tailwind)

Primary button
```html
<button class="font-mono text-sm rounded-md px-4 py-2.5 bg-accent-600 hover:bg-accent-500 text-white transition-colors">
  Convert
</button>
```

Secondary button
```html
<button class="font-mono text-sm rounded-md px-4 py-2.5 bg-surface-2 hover:bg-graphite-700 text-fg border border-border transition-colors">
  Cancel
</button>
```

Status pill (example: warning)
```html
<span class="font-mono text-xs rounded-full px-2.5 py-1"
      style="background:var(--bg-warning);color:var(--fg-warning)">
  resample 48 kHz
</span>
```

Track row (list)
```html
<div class="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-surface-2">
  <span class="font-mono text-sm text-fg truncate">artist – title.wav</span>
  <span class="font-mono text-xs text-fg-subtle ml-auto">96 kHz · 24-bit</span>
  <span class="font-mono text-xs rounded-full px-2 py-0.5"
        style="background:var(--bg-warning);color:var(--fg-warning)">→ AIFF</span>
</div>
```

Drop zone
```html
<div class="rounded-lg border-2 border-dashed border-border-strong bg-surface
            p-10 text-center text-fg-muted font-sans">
  Drag files here or <span class="text-accent-400">select</span>
</div>
```

Card
```html
<section class="rounded-lg border border-border bg-surface p-5 shadow-md">…</section>
```

Waveform (canvas/SVG): bars in `accent-500`, baseline/grid in
`graphite-700`. Source colors from `theme.ts` (`accent[500]`) so that UI and
waveform stay consistent.

---

## 7. Dark / Light

Dark is the default. Toggle via the attribute on `<html>`:
```html
<html data-theme="dark">   <!-- or "light" -->
```
All semantic tokens (`bg`, `surface`, `fg`, …) and status surfaces
switch automatically. Ramps (`accent-*`, `graphite-*`) are fixed — so use the
semantic tokens for surfaces/text, not the ramps.

---

## 8. Do / Don't

**Do:** dark calm surface, one accent, monospace for data, status color =
compatibility, plenty of contrast on small text.

**Don't:** mix multiple accent colors, gradients/glow, use status colors
decoratively (semantic only!), body text in monospace, Title Case.
