---
name: rekord-lib
description: A dark, monospace mastering desk for judging whether an audio file will play on a CDJ.
colors:
  accent-600: "#574BC0"
  accent-500: "#6A5FD6"
  accent-400: "#8177E0"
  accent-300: "#9C93E9"
  accent-200: "#BCB6F1"
  graphite-700: "#343440"
  bg: "#100F14"
  surface: "#17161D"
  surface-2: "#201F28"
  border: "#292933"
  border-strong: "#343440"
  fg: "#F6F6F8"
  fg-muted: "#B7B7C0"
  fg-subtle: "#8C8C98"
  fg-disabled: "#5A5A66"
  focus: "#8177E0"
  success-500: "#22B27A"
  warning-500: "#F5A623"
  danger-500: "#E5484D"
  danger-600: "#D13239"
  info-500: "#3B82F6"
typography:
  display:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "1.125rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  title:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "normal"
  body:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "normal"
  prose:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  micro:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "normal"
  label:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.35
    letterSpacing: "normal"
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
spacing:
  "0.5": "2px"
  "1": "4px"
  "1.5": "6px"
  "2": "8px"
  "3": "12px"
  "4": "16px"
  "5": "20px"
  "6": "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent-600}"
    textColor: "{colors.fg}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-primary-hover:
    backgroundColor: "{colors.accent-500}"
    textColor: "{colors.fg}"
  button-primary-disabled:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg-disabled}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.fg-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  button-secondary-hover:
    textColor: "{colors.accent-400}"
  button-destructive:
    backgroundColor: "{colors.danger-600}"
    textColor: "#FFFFFF"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "0 16px"
    height: "36px"
  button-icon:
    backgroundColor: "transparent"
    textColor: "{colors.fg-muted}"
    rounded: "{rounded.md}"
    height: "36px"
    width: "36px"
  button-transport-play:
    backgroundColor: "{colors.accent-600}"
    textColor: "{colors.fg}"
    rounded: "{rounded.full}"
    height: "36px"
    width: "36px"
  tab-active:
    backgroundColor: "rgb(87 75 192 / 0.2)"
    textColor: "{colors.accent-200}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  tab-idle:
    backgroundColor: "transparent"
    textColor: "{colors.fg-muted}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "36px"
  input:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  pill-warning:
    backgroundColor: "rgb(245 166 35 / 0.15)"
    textColor: "{colors.warning-500}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: "2px 8px"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.lg}"
    padding: "20px"
  menu-panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.fg}"
    rounded: "{rounded.lg}"
    padding: "16px"
    width: "320px"
  table-row:
    backgroundColor: "transparent"
    textColor: "{colors.fg}"
    typography: "{typography.body}"
    padding: "0 16px"
    height: "64px"
  table-row-hover:
    backgroundColor: "{colors.surface-2}"
---

# Design System: rekord-lib

> **This file is binding for the visual system.** Colours, typography, layout,
> depth, shape, components and the named rules live here, and
> `src/styles/tokens.css` is the implementation of the tokens named below.
> [`docs/brand/STYLEGUIDE.md`](docs/brand/STYLEGUIDE.md) owns the other half —
> the logo and brand assets, and how the project is wired up (font packages, the
> `data-theme` attribute). Each fact belongs to exactly one of the two.
>
> The file is regenerable: `/impeccable document` re-extracts it from the code
> together with `.impeccable/design.json`. A refresh has to *merge* — the named
> rules, their reasons and the test references below were written by hand and
> are not recoverable from tokens.

## Overview

**Creative North Star: "The Mastering Desk"**

rekord-lib looks like a piece of studio equipment, not like a music app. The
surface is near-black, the type is monospace almost everywhere, and the numbers
that matter — `44.1 kHz`, `24-bit`, `128.0 BPM`, `AIFF` — sit in columns that
line up because the font makes them line up. One violet accent runs through the
instrument and marks the signal: the waveform, the progress bar, the primary
action. Everything else is graphite.

The mood is **calm, precise, incorruptible**. Nothing pushes, nothing
celebrates. The interface's job is to state a verdict about a file the user
cannot inspect by ear — whether a CDJ will refuse it — and a readout that
exaggerates is worse than no readout. So color is spent on meaning, never on
mood: green means this file is ready, amber means it needs work, red means a
player will refuse it, violet means *this is the thing to act on*. A screen with
no problems is a screen with almost no color in it, and that is the intended
resting state.

Controls are **quiet until touched**. At rest a button is a hairline and a
label; the track list dominates and the chrome recedes. On hover the border or
the icon picks up the accent, and that is the whole gesture. Depth works the
same way: three surface tones (`bg` → `surface` → `surface-2`) carry the
layering, and a shadow appears only under something that genuinely floats — a
menu, a dialog, the header once it docks. The two things this must never look
like are an **enterprise data grid** (grey toolbars, zebra rows, a border around
every cell) and a **playful consumer app** (illustrations, coachmarks, emoji,
encouraging copy).

**Key Characteristics:**

- Dark by default (`data-theme="dark"` on `<html>`); light is a shipped theme
  the user can pick in Settings, along with "System" to follow
  `prefers-color-scheme`. It earned that sentence in 0.9.2 — before then it was
  unreachable and, measured, unusable.
- Monospace as the *default* voice of the UI — Inter is opted into for prose.
- Exactly one accent (violet), and status color that only ever means
  compatibility.
- Every button 36 px tall, stated as a height and enforced by a test.
- Flat surfaces, hairline borders, shadows reserved for floating layers.
- Compact density: 64 px track rows, `px-3 py-2` cells, 12 px gaps.

## Colors

A cool, near-monochrome graphite field with a single violet accent taken
straight from the logo, plus three status hues that are strictly semantic.

### Primary

- **Waveform Violet** (`accent-500`, #6A5FD6): the base of the brand and
  literally the signal — waveform bars, progress fills, the dot that says
  something is unread. `accent-600` (#574BC0) is the primary *action* surface
  (buttons), hovering to `accent-500`. `accent-400` (#8177E0) and `accent-300`
  (#9C93E9) are the text/icon weights that carry enough contrast on dark;
  `accent-200` (#BCB6F1) labels the active navigation tab over a 20 %
  `accent-600` wash.

### Neutral

- **Cold Graphite** — the whole chassis, consumed through theme-dependent
  semantic tokens rather than the ramp: `bg` (#100F14) as the app field,
  `surface` (#17161D) for panels, cards and the resting header, `surface-2`
  (#201F28) as the raised tone for menus, inputs, hovered rows and skeletons.
- **Lines:** `border` (#292933) is the hairline that separates everything;
  `border-strong` (#343440) outlines an interactive control (secondary buttons,
  inputs, the tab group) so a control reads as a control without a fill.
- **Text:** `fg` (#F6F6F8) for the value the user came for, `fg-muted`
  (#B7B7C0) for secondary text *and for live status the user reads but cannot
  click* (scan stages, spinners), `fg-subtle` (#8C8C98) for meta and
  placeholders, `fg-disabled` (#5A5A66) for anything inert.
- `graphite-700` (#343440) is the one ramp value used raw in rendering: the
  baseline and grid under the canvas waveform.
- Light theme redefines the same nine semantic tokens in `tokens.css`
  (`bg` #F6F6F8, `surface` #FFFFFF, `fg` #100F14, …). The accent and graphite
  ramps are fixed across themes.

### Status — the verdict palette

- **Verdict Green** (`success-500`, #22B27A): compatible, ready, done — and an
  action that finished, all of it.
- **Convert Amber** (`warning-500`, #F5A623): conversion needed, metadata
  incomplete, FLAC/ALAC restricted to NXS2/CDJ-3000 — anything still to do, and
  an action that finished only partly.
- **Refuse Red** (`danger-500`, #E5484D): incompatible, E-8305 risk, delete —
  and an action that failed.
- **Info Blue** (`info-500`, #3B82F6): defined in the tokens; the UI currently
  reaches for `accent-300` for informational markers instead.

### Named Rules

**The Two-Theme Rule.** Type takes its colour from whatever it sits *on*, and
that is the whole rule:

- on a **theme-dependent surface** (`bg`, `surface`, `surface-2`, or a
  translucent tint composited over one) the type takes a theme-dependent token —
  `fg`, `fg-muted`, `fg-success`, `fg-accent`, and so on;
- on a **fixed ramp fill** (`bg-accent-600`, `bg-danger-600`) the type takes a
  fixed colour, `text-white`, because the fill does not move with the theme and
  a label that does will be wrong in one of them. Saying nothing counts as
  getting this wrong: the label then inherits `fg`, which is exactly how a
  near-black label ended up on dark violet at 2.9:1 in light mode.

`bg-danger-600` (#D13239) exists for the second half of that: `danger-500`
carried a white label at 3.9:1, on the button that moves files to the trash.
The 500 stays the colour; the 600 is the action, the way `accent-600` already
was.
This is not symmetry for its own sake — the ramps are fixed across themes, and
measured against the light surfaces `warning-500` is 1.9:1 and `accent-200`
1.8:1, which is why `--fg-success`, `--fg-warning`, `--fg-danger`, `--fg-accent`
and `--focus` exist and why a bare `text-warning-500` is a defect.
`src/styles/contrast.test.ts` does the arithmetic over both theme blocks, so the
claim is checked rather than asserted.

**The Semantic Colour Rule.** Green, amber and red only ever describe a
**verdict** — how a file stands, or how an action turned out. A status colour
used because it looks good is a defect; there is no decorative green in this
app. The corollary: a build label that is merely a heads-up ("Beta") takes the
accent, not amber, because it is announcing itself rather than judging
anything.

Verdicts come in two kinds, and 0.10.0 added the second. A **file** is
compatible, needs converting, or will not play — that is the track row's status
column and the oldest use of these three hues. An **action** finished, finished
partly, or failed — that is a transient message (`Toasts`), and it takes the
same three because it is the same kind of statement about a different subject.
The palette was briefly mixed on this point: the messages shipped with amber
for a partial run and red for a failure but the accent for a clean one, which
made the one good outcome the exception rather than the top of a scale.

What this does **not** license is a green that means "nice": a completed action
is green because it is a verdict on a run, not because the run deserves
congratulating. Nothing in this app celebrates. And the two kinds stay apart on
screen — a verdict about a file is an icon in its row, a verdict about an
action is a sentence in a message — so a green that means "this plays on a CDJ"
is never next to a green that means "that worked".

**The One Accent Rule.** Violet is the only brand colour. No second accent, no
gradient, no glow — including as a skeleton shimmer, which is why placeholders
pulse their opacity instead.

**The Opacity Rule.** Never express *disabled* with `opacity`. Opacity
multiplies with whatever colour the content already carries, so the same state
lands on a different grey in every control. Say it in colour: a filled control
becomes `bg-surface-2` + `text-fg-disabled`, an outlined one drops to
`border-border` + `text-fg-disabled`, an icon or input just goes
`text-fg-disabled`. Guard every hover with `enabled:` — `:hover` still matches a
disabled button. `src/styles/disabledStates.test.ts` enforces all three over the
source.

**The Tinted-Ring Rule.** A status surface is a 15 % tint of the status colour
with a 30 % ring of the same hue and the **theme-dependent** hue as text
(`bg-warning-500/15 text-fg-warning ring-1 ring-warning-500/30`) — a ring rather
than a border, because a pill sits inside a row and a border would move the
text. The text token is `fg-warning`, not the bare ramp: the tint composites
over a theme surface, so the Two-Theme Rule applies inside the pill exactly as
it does outside it. This is the only form.

Two corrections this rule carried until 0.10.0, worth keeping visible because
both were written down and both were wrong. It gave `text-warning-500` as the
example, contradicting the Two-Theme Rule twelve paragraphs above it; and it
added that "there is no `text-fg-warning` utility", which `tokens.css` and
eleven call sites had already disproved. A colour utility no token defines
generates *nothing* rather than failing — that part was right, and it is how two
uncertain-tempo markers rendered in the inherited colour for several releases.
`src/styles/designRules.test.ts` fails on one.

## Typography

**Display / Data / UI Font:** JetBrains Mono (`font-mono`, with
`ui-monospace, SFMono-Regular, Menlo` behind it)
**Prose Font:** Inter (`font-sans`, with `ui-sans-serif, system-ui,
-apple-system` behind it)

**Character:** Monospace is not an accent here, it is the voice of the whole
instrument — `font-mono` sits on the app root, so every filename, tempo, sample
rate, format tag, button label and table cell is monospaced and columns align
without tabular-figure tricks. Inter is the deliberate exception, opted into for
the ~19 places that carry real sentences: help text under a setting, a release
note, an explanation in a dialog. The pairing reads as *instrument readout plus
manual*.

### Hierarchy

- **Display** (mono 500, 18px/`text-lg`): the largest thing in the app — a
  modal's own title ("Metadata"), an empty-state headline. There is no `text-xl`
  or `text-2xl` anywhere in the UI.
- **Title** (mono 500, 14px/`text-sm`): section and dialog headings. The app's
  headings are the same *size* as its body text and separate themselves by
  weight and colour, which is what keeps a dense tool from looking like a
  document.
- **Body** (mono 400, 14px/`text-sm`): the working size — track titles, cell
  values, button labels, inputs. By far the most used step (≈138 occurrences).
- **Prose** (Inter 400, 14px/`text-sm`, or 12px for hints): descriptive
  sentences only, usually `text-fg-subtle` or `text-fg-muted`.
- **Label** (mono 400, 12px/`text-xs`): meta and secondary values — sample rate
  next to a format, download progress, tallies, pill text (≈75 occurrences).
- **Micro** (mono 400, 11px/`text-[11px]`): the floor, and only where 12 px does
  not physically fit — a corner badge inside a 16 px circle, a format tag on a
  cover, a progress detail line under a download. There was briefly a second
  micro size at 10 px doing the same job; one step is enough, and nine usages
  now share it.

### Named Rules

**The Floor Rule.** 11 px is the smallest type in the app and needs a physical
reason — something that does not fit at 12 px. A third micro size is not a
refinement, it is two sizes doing one job, which is what `10px` and `11px` were
until 0.9.2.

**The Sentence Case Rule.** Sentence case everywhere. No Title Case, no ALL
CAPS — including for data that arrives lowercase, which is not made to shout by
an `uppercase` class. Enforced over the source by
`src/styles/designRules.test.ts`.

**The Two Weights Rule.** 400 regular and 500 medium, nothing else. A heading
separates itself by weight and colour, not by a third level — which is why 600
is not available to reach for. Enforced over the source by
`src/styles/designRules.test.ts`.

**The Mono-Default Rule.** Do not reach for `font-sans` for anything that is a
value, a label, a control or a table cell. Reach for it exactly when you are
writing a sentence the user reads once.

## Layout

The app is a single 100 %-height column: a **64 px sticky header** (`h-16`,
`z-30`, `px-6`) carrying the logo, the build chip and the right-aligned action
slot, then the view. In the library view a second **56 px sticky bar** (`h-14`,
`z-20`) docks directly beneath it at `top-16` and carries grouping, column,
filter and search controls. Both dock on scroll over 300 ms, to an **opaque** `bg-bg` with a hairline and
`shadow-lg shadow-black/40` — the shadow is what says they float.

The track list is a real `<table>` (`table-fixed`, `min-w-[95rem]`) inside a
horizontally scrolling container, virtualized, with **64 px rows** separated by
`border-b border-border` and `last:border-0`. Row internals are `px-3 py-2` at
`gap-3`. Bandcamp's collection switches between the same list rhythm and a
responsive cover grid (`grid-cols-2 sm:grid-cols-3 md:grid-cols-4`, `gap-4`).

The playlists view is the one **two-pane** screen: a `w-64` sidebar of
playlists beside the open one, `gap-6`, `items-start`. The sidebar is `sticky
top-16` rather than a panel of its own, because **the window is what scrolls in
this app** — `useScrolled` reads `window.scrollY`, both bars dock off it and
the back-to-top button drives it. Only the sidebar's *list* may scroll on its
own, and only when there are more playlists than fit; a pane with its own
scrollbar would be the app's first and would leave the back-to-top button
pointing at something the user is not looking at.

**Spacing** is Tailwind's 4 px scale, and the app really only uses seven steps:
`0.5` (2px) for pill padding, `1`/`1.5` (4/6px) for icon clusters, `2` (8px) as
the default control gap, `3` (12px) for row padding and list gaps, `4` (16px)
between blocks, `5` (20px) for card padding, `6` (24px) for the window gutter.

**Density is a decision, not an accident:** this is a power-user tool, so line
heights are tight and rows are as short as a 40 px cover thumbnail allows.

### Named Rules

**The Falling-Order Truncation Rule.** When a line carries more than one value —
artist and album under the player's title, format and sample rate in a cell —
the values are written in falling order of what they answer, and the *last* one
gives way first as the window narrows. In flexbox terms: `min-w-0 truncate` on
both, `shrink-[999]` on the one that must go first. Never a fixed width, which
would truncate a short value that would have fit; where a value must not be cut
at all it is `shrink-0` and something else yields.

**The Downward Menu Rule.** A menu opens downward and above the header:
`absolute right-0 top-full mt-2 z-40`. The actions live in a 64 px sticky header
at `z-30`, so `bottom-full` puts the panel off the top of the window, and `z-30`
would leave the winner to document order. The layer stack is: header 30, docked
filter bar 20, menus 40, modal overlay 50, transient message 60.
`src/components/menuPlacement.test.ts` reads the source and `e2e/menus.spec.ts`
measures where the panel actually lands.

Sixty is the only floor above the modal, and it exists because a message that
arrives while a dialog is open still has to be read — a conversion finishing
behind the event log is exactly when silence is worst. It is also the only layer
that never intercepts a pointer (`pointer-events-none`) and the only floating
thing that is *anchored* rather than `inset-0`, which is what keeps it from
being mistaken for an overlay by anything reading the DOM.

## Elevation & Depth

**Flat, with tone instead of shadow.** Depth comes from the three surface
tones — `bg` behind everything and, inside a panel, as the well an expanded
group sits in (see The Well Rule); `surface` for panels and cards; `surface-2`
for what is raised or active (menu bodies, inputs, hovered rows, skeletons) —
plus a single hairline `border-border`. A surface never carries both a double
frame and a shadow.

Shadows are reserved for things that genuinely float above the page, and there
are only three in the vocabulary. Motion is the same kind of hint: 150 ms fades
for anything appearing, 300 ms for the header docking, 1.1–1.6 s loops for the
skeleton pulse and the equalizer bars on the splash — and **all of it is
switched off under `prefers-reduced-motion`** — by
`[class*="animate-"] { animation: none }` rather than by a list of animation
names, because a list is exactly what let `animate-spin` and `animate-pulse`
keep running for two releases. Content is always complete in its final state,
and where motion was the *only* thing saying "working", it now has words beside
it.

### Shadow Vocabulary

- **`shadow-sm`** (`0 1px 2px rgb(0 0 0 / 0.30)`): the quietest lift; defined in
  the tokens, rarely needed.
- **`shadow-md`** (`0 4px 12px rgb(0 0 0 / 0.35)`): the default for a popover or
  a dialog panel — a filter or column menu.
- **`shadow-lg`** (`0 12px 32px rgb(0 0 0 / 0.45)`): the docked header and the
  larger floating panels, usually written as `shadow-lg shadow-black/40`.
- Modal backdrop: `bg-black/60` over the whole viewport at `z-50`, portalled
  into `document.body` so no ancestor transform can re-anchor it, with the page
  behind it scroll-locked.

### Named Rules

**The No-Blur-Over-Motion Rule.** A `backdrop-filter` re-samples and re-blurs
everything beneath it on **every frame the content moves**. That is the whole
cost and the whole rule: it is expensive exactly where something scrolls
underneath, and free where nothing moves. The app shipped four of them — the
sticky header and the filter bar switched on `backdrop-blur` at the same scroll
threshold, full width, over the virtualized table, and scrolling stuttered from
the moment they docked; the player bar paid the same cost permanently. A blur
over something still is fine, and the Bandcamp cover badge at `bg-black/60`
keeps its own.

`src/styles/designRules.test.ts` enforces a **proxy** for this, not the rule
itself: no `backdrop-blur` behind a surface at 80 % opacity or more. A test
reading class strings cannot know what scrolls under what, and in this app the
two coincided. Do not mistake the proxy for the reason — the first version of
this rule claimed a blur behind 80 % opacity is "almost invisible", and that was
simply wrong. It was visible, the maintainer liked it, and it went anyway
because of the frame cost. A blur is worth having where nothing moves beneath
it; the docked bars are not that place.

For the record, since the question will come back: the only way to keep the
effect *unchanged* is to blur at rest and drop it during the gesture — the look
is only perceivable when the content is still. That costs a scroll-idle state
and a short delay after release, and it was offered and not taken.

**The Tone-Before-Shadow Rule.** If two things need to be told apart, move one
to the next surface tone. Add a shadow only when the element is actually
floating over content — a menu, a dialog, a header that has left its resting
position.

**The Well Rule.** An expanded group — an album, a folder, a label, a
playlist — drops its head row *and every row it contains* to `bg`, the field
tone, one step **below** the panel they sit in. Nothing gets lighter, because
the light end of the ladder is already spent: `surface-2` is the hover tone, and
a resting state written in it is indistinguishable from the row the pointer
happens to be on.

The rule exists because the obvious fix does not work, and the numbers say why.
Measured between the three tones:

| pair | dark | light |
| --- | --- | --- |
| `surface` ↔ `surface-2` (the hover step) | 1.10 : 1 | 1.18 : 1 |
| `surface` ↔ `bg` (the well step) | 1.06 : 1 | 1.08 : 1 |
| `bg` ↔ `surface-2` (hover *inside* a well) | 1.17 : 1 | 1.09 : 1 |

Across a single 64 px row none of that is visible, which is why an open group
read as closed in a screenshot and why "make the head a step lighter" would not
have fixed it — in either direction, and no fourth tone would have changed the
arithmetic. What makes a tone step legible is **area**: a head plus the rows
under it is a block with a sharp edge at each end, and an edge that long is
readable at a contrast a single row is not. So the state moves the contents, not
the head. Note also that the step is a *role*, never a direction: in light mode
`surface-2` (#ECECEF) is darker than `surface` (#FFFFFF), so "a shade lighter"
is a dark-mode assumption that inverts.

Depth of nesting is **not** in the tone and cannot be: folders nest without a
limit and the ladder has three rungs. Tone says whether a row is inside a group;
the title indent (16 px, plus 20 px per level) says how deep.

The one thing that must not move is hover. Every row hovers to `surface-2`,
including the head of an open group — on dark that makes it the largest hover
step in the table, and on light the smallest, which is recorded rather than
hidden. It stays uniform because the row-actions overlay is a `surface-2` patch
that fades the columns out behind the buttons, and it only disappears into a row
that is exactly that tone.

`src/styles/contrast.test.ts` measures the tones against each other and
`src/styles/designRules.test.ts` fails on a resting state written in the hover
tone.

## Shapes

One corner language, four radii, and no exceptions invented per screen:
**every control is `rounded-md` (8 px)** — buttons *and* text fields, so a
search field and the buttons beside it in a toolbar share one corner. Surfaces
come in two tiers, and the tier follows the size: a floating panel, a menu or a
card *inside* another panel is `rounded-lg` (12 px), while a page-level section
is `rounded-xl` (16 px) — the seven settings sections, the empty states, the
duplicate-group cards and the track-list shell. Pills, dots, progress bars and
transport buttons are `rounded-full`. A
checkbox or radio is a 14 px square and keeps Tailwind's small `rounded`, since
an 8 px corner on a 14 px box is a circle. A one-sided border accent (`border-l`
only) is `rounded-none`.

Borders are hairlines: `border-border` for structure, `border-border-strong` for
an interactive outline, `border-2 border-dashed border-border-strong` for a drop
zone. The drop target announces itself by colour rather than shape — the
container turns `border-accent-500 bg-accent-500/5` while a drag is over it.

Icons are 18–20 px stroke glyphs at `stroke-width 2`; 16 px is only for
decoration that cannot be clicked.

### Named Rules

**The One Ring Rule.** Keyboard focus is **one** ring, defined once in
`index.css` as `:focus-visible { outline: 2px solid var(--focus); outline-offset:
2px }` — never per component, and never suppressed. `--focus` is
theme-dependent because no single step of the accent ramp clears 3:1 against
both themes' surfaces: `accent-400` on dark (4.4:1 at worst), `accent-600` on
light (5.6:1). The offset matters — it puts the ring on the page rather than on
the control, so the surface behind it is what needs the contrast. The rules are
deliberately *unlayered* so no Tailwind `outline-*` utility can outrank them,
and `src/styles/designRules.test.ts` fails on a component that writes
`outline-none` at all. Before 0.9.2 there were sixteen of those and no
replacement.

**The 36 px Rule.** Every button is `h-9` (36 px), stated as a height and never
derived from padding — a label is 20 px tall, an icon 16, a cover 40, so padding
gives a different height to every control that carries something different. An
icon-only button is square at the same number (`h-9 w-9`), centred, never a bare
glyph. Horizontal padding is free: `px-4` normally, `px-3` where a row of
controls is tight, `px-2` in a table cell.
`src/components/buttonShape.test.ts` enforces both the height and the corner
over the source.

## Components

Each entry leads with the character, then shape, colour and states. **Copy from
the implementation, not from a snippet here** — the styleguide used to carry
copy-paste Tailwind recipes and they were a third copy of every component, kept
honest by nothing. The canonical build of each is:

| Component | As built in |
| --- | --- |
| Primary button | `src/components/BulkMetadataEditor.tsx` (the *Apply* action) |
| Secondary / outlined button | `src/components/LibraryView.tsx` (the toolbar row) |
| Destructive button | `src/components/DuplicatesModal.tsx` |
| Icon button with badge | `src/components/HeaderNav.tsx` |
| Segmented navigation | `src/components/HeaderNav.tsx` (`TabButton`) |
| Text field | `src/components/LibraryView.tsx` (search), `MetadataEditor.tsx` (form) |
| Status pill | `src/components/AppHeader.tsx` (`BuildChip`) |
| Status icons | `src/components/StatusIcons.tsx` |
| Card / section | `src/components/SettingsView.tsx` |
| Menu panel | `src/components/FilterMenu.tsx` |
| Track row | `src/components/LibraryView.tsx` |
| Transport controls, progress | `src/components/PlayerBar.tsx` |
| Skeleton | `src/components/Skeleton.tsx` |

`.impeccable/design.json` additionally carries self-contained HTML/CSS for nine
of these, for tools that render a preview rather than read React.

### Buttons

- **Shape:** 8 px corner (`rounded-md`), 36 px tall (`h-9`),
  `inline-flex items-center justify-center`, mono label at `text-sm`.
- **Primary:** violet fill (`bg-accent-600`) with a `text-white` label stated
  explicitly, `px-4`, `font-medium`, hovering to `accent-500` via
  `enabled:hover:`; disabled becomes `bg-surface-2` + `text-fg-disabled`, both
  theme-dependent because that surface is. One primary per context — it is the
  thing to do next.
- **Secondary / ghost:** no fill, `border border-border-strong`, `px-3`,
  `text-fg-muted`, hovering to `border-accent-500` + `text-accent-400`;
  disabled drops to `border-border` + `text-fg-disabled`.
- **Destructive:** filled `bg-danger-600` with a white label for the confirmed
  action inside a dialog — the darker step, so the label clears 4.5:1; outlined
  with
  `enabled:hover:border-danger-500 enabled:hover:text-danger-500` where the
  button sits in a toolbar and deletion is one option among several.
- **Icon-only:** `h-9 w-9 rounded-md border border-border-strong`,
  `text-fg-muted` hovering to accent, always with `title` *and* `aria-label`.
  Corner badges (unread, update, active downloads) are 8–10 px `rounded-full`
  dots at `-right-0.5 -top-0.5`, and the gear's dot carries `ring-2 ring-bg` to
  hold its edge against the header.
- **Transport:** `h-9 w-9 rounded-full` — play/pause filled `bg-accent-600`,
  previous/next unfilled `text-fg-muted` with `disabled:text-fg-disabled`.

### Navigation

The Library/Bandcamp switch is a segmented control: a wrapper at
`rounded-lg border border-border-strong p-0.5 gap-1`, and inside it 36 px tabs
at `rounded-md px-3 text-sm`. Active is a 20 % accent wash with
`text-accent-200`; idle is `text-fg-muted` hovering to `text-fg`. Never more
than one active.

### Inputs / Fields

- **Style:** `rounded-md border border-border-strong bg-surface-2 px-3 py-1.5`
  (`py-2` in the metadata editor), mono at `text-sm`, `outline-none` — the same
  8 px corner as every button.
- **Focus:** the shared ring (see the One Ring Rule) *plus* the border turning
  `accent-500` — two signals, because a field is where a keyboard user spends
  the most time. The border alone was the whole indicator until 0.9.2, which
  meant the app had no designed focus state at all.
- **Disabled / read-only:** `text-fg-subtle`, no fill change, never `opacity`.
  The path field in the metadata editor is the canonical example.
- Search is a native `type="search"` at `w-56` in the docked filter bar.

### Cards / Containers

- **Corner:** `rounded-xl` (16 px) for a page-level section — a settings card,
  an empty state, the track-list shell; `rounded-lg` (12 px) for a panel that
  floats or sits inside another one. Bigger surface, bigger corner.
- **Background:** `bg-surface` on `bg-bg`; `bg-surface-2` when the card is
  itself inside a panel (an event log entry, a menu row).
- **Border:** one hairline `border-border`.
- **Shadow:** none at rest — see Elevation & Depth.
- **Padding:** `p-5` for a settings section, `p-4` for a menu panel, `p-2` for a
  compact list card.

### Menus / Popovers

`absolute right-0 top-full z-40 mt-2` with `rounded-lg border border-border`,
`bg-surface` + `p-4` for a form-like panel (filter) or `bg-surface-2` + `py-1`
for a list of choices (playlists, add-to), `w-44` to `w-80`, `shadow-md` or
`shadow-lg shadow-black/40`, and dismissal on outside click via `useDismiss`.
Long panels cap with `max-h-80 overflow-y-auto`.

### Table Row (signature component)

The track row is the heart of the app: `group h-16 border-b border-border
last:border-0 hover:bg-surface-2`, with a 40 px cover thumbnail, the title in
`text-fg`, technical values in `text-xs text-fg-subtle`, and a status column of
small stroke icons — amber for "still needs doing", green for done, accent for
informational — whose meaning lives in the `title` and `aria-label`, never in
the colour alone. An overflowing title scrolls as a marquee **only while its row
is hovered** (`.group:hover .marquee-track`, two copies, `-50%` shift for a
seamless loop), and stops off under reduced motion.

A **group head** is the same row at the same height: `bg-surface-2/40` closed,
in the well (`bg-bg`) when open, and its chevron goes from `text-fg-subtle` to
`text-fg` with it. It carries `aria-expanded`, because a state that is only a
tone and a glyph is no state at all to a screen reader.

### Status Pill

`rounded-full px-2 py-0.5 text-xs ring-1` with the tinted-ring triple
(15 % background, solid text, 30 % ring). Used for the build chip, format tags
and duplicate-group markers — never as a substitute for the status icons in a
row, which stay icons so the row height cannot grow.

### Progress

A 6 px track (`h-1.5 rounded-full bg-surface-2`) with an `accent-500` fill and
`transition-all duration-300`; indeterminate progress is a `w-1/3` segment with
`animate-pulse`. The player's own progress is a 2-tone bar drawn at the top edge
of the bar.

### Skeleton

`animate-skeleton rounded-md bg-surface-2`, `aria-hidden`, sized to the content
it replaces so nothing jumps on swap. Table skeletons render *instead of* the
table (never inside it — the virtualizer measures every row in `<tbody>` by
position), and only while the list is still empty.

## Do's and Don'ts

### Do:

- **Do** take every colour from `src/styles/tokens.css` — semantic tokens for
  surfaces, text and lines; `accent-*` for brand, action and progress; the three
  status hues for compatibility only.
- **Do** state a button's height as `h-9` and make an icon-only button `h-9 w-9`.
- **Do** default to `font-mono` and opt into `font-sans` only for sentences.
- **Do** express disabled in colour (`disabled:bg-surface-2`,
  `disabled:text-fg-disabled`, `disabled:border-border`) and guard hovers with
  `enabled:`.
- **Do** open menus with `right-0 top-full mt-2 z-40`.
- **Do** give a new animation a token in `tokens.css`. The
  `prefers-reduced-motion` block already covers every `animate-*` class, so
  there is no list to maintain — but check that whatever the motion was saying
  is still said without it.
- **Do** let the later value truncate first when a line carries several
  (`shrink-[999]`).
- **Do** carry meaning in text as well as colour — a coloured dot is 10 px of
  hue and not a message, so the tooltip and the accessible name say the level.

### Don't:

- **Don't** use a Tailwind default palette (`neutral-*`, `sky-*`, `emerald-*`) or
  a raw hex in a component.
- **Don't** use a status colour decoratively, or a second accent, or a gradient
  or glow anywhere — including a shimmer sweep across a skeleton.
- **Don't** express disabled with `opacity`.
- **Don't** derive a control's height from padding, and don't put a bare glyph
  where a 36 px square button belongs.
- **Don't** set body text in mono's place *or* set a value, label or table cell
  in Inter.
- **Don't** use Title Case, ALL CAPS, or weight 600/700.
- **Don't** put a theme-dependent text token on an opaque ramp fill, and don't
  leave such a fill's label to inheritance — see the Two-Theme Rule.
- **Don't** write a focus style on a component, or suppress the shared one with
  `outline-none` — see the One Ring Rule.
- **Don't** write a colour utility no token defines (`bg-bg-danger`,
  `text-surface-3`). Tailwind generates nothing for it and the element silently
  keeps the inherited colour. The status hues are `text-fg-warning` on a theme
  surface and `bg-success-500/15` for a tint — see the Tinted-Ring Rule, which
  gave the wrong example here until 0.10.0.
- **Don't** write a resting state in the hover tone. `surface-2` means the
  pointer is here; a state the user is holding goes the other way — see The Well
  Rule.
- **Don't** put `backdrop-blur` behind a surface at 80 % opacity or more, and
  never on something a list scrolls under — see the No-Blur-Over-Motion Rule.
- **Don't** stack a shadow on a bordered surface to create depth — move it to
  the next surface tone instead.
- **Don't** animate list rows; animate the container, because the table renders
  only its visible rows and a per-row animation refires on every scroll.
- **Don't** make it look like an **enterprise data grid** — no grey toolbars, no
  zebra striping, no border around every cell, no default framework blue.
- **Don't** make it look like a **playful consumer app** — no illustrations, no
  coachmarks, no emoji in the UI, no encouraging copy. The app states facts about
  files.
