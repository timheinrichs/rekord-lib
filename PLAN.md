# Plan — the audit's findings, 0.9.2

## Version

**PATCH: 0.9.1 → 0.9.2** for most of it. One item is a judgement call: the
**light theme becomes reachable**, which is user-facing and new, and that is a
MINOR by the rule in `CLAUDE.md`. Called **0.10.0** if the theme switch ships in
the same release as the rest; called 0.9.2 if the switch is held back. Decided
when the work lands, not now — the rest of the list is unambiguous PATCH.

## Where the list comes from

`$impeccable audit` on 2026-09-17 scored the app **15/20** (Good): a11y 2,
performance 3, theming 3, responsive 3, implementation integrity 4. Nine
findings, and two of them are this repo's own absolute claims being false rather
than WCAG violations — which is the same class of defect 0.9.1 fixed, one layer
out.

## P1 — before anything else

### 1. A designed focus state

Today: no `:focus-visible` anywhere, 16 × `outline-none`. Buttons borrow the
macOS ring in the system accent colour; text fields signal focus only by a
border shift (measured 3.3:1 against the field fill — SC 1.4.11 passes, but it
is a side effect rather than a decision).

- One recipe in `DESIGN.md` as a named rule, then applied to every control:
  `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400`.
  `accent-400` measures 5.1:1 on `bg` and 4.4:1 on `surface-2`, so it clears the
  3:1 non-text minimum on every surface the app has.
- Keep `outline-none` only where a field replaces the outline with something at
  least as visible; otherwise drop it.
- Guard it in `designRules.test.ts`: a control that sets `outline-none` must
  also set a `focus-visible:` utility. That is the shape of the defect — the
  suppression and the replacement drift apart.

### 2. Reduced motion actually means every animation

`animate-spin` (`icons.tsx:115`, the scan spinner) and `animate-pulse`
(`HeaderNav.tsx:169`, the indeterminate download bar) are both **infinite** and
neither is in the `prefers-reduced-motion` block, which names five animations
one by one. `DESIGN.md` says "every animation is switched off", so the document
is wrong today.

- Stop enumerating. The block should cover Tailwind's own `animate-*` utilities
  as a class, not by name, because a list loses to the next utility somebody
  reaches for.
- A spinner that cannot spin still has to say "working": keep it visible and
  let the adjacent stage text carry the progress.
- Guard: assert every `animate-*` class used in the tree is covered by the
  reduced-motion block. This is checkable over the source with the existing
  scanner.

## P2

### 3. The light theme gets fixed and shipped

**Decided:** repair it, do not drop it. Measured against the light surfaces, the
fixed ramps fail as text — `warning-500` **1.9:1**, `success-500` 2.5:1,
`accent-300` 2.5:1, `accent-200` **1.8:1** — and `StatusIcons`, `BuildChip`, the
active `TabButton` and the duplicate pills use exactly those unconditionally.
Root cause is in `DESIGN.md`'s own words: *"the accent and graphite ramps are
fixed across themes"*, which cannot hold for text colour.

- Add theme-dependent **text** tokens: `--fg-success`, `--fg-warning`,
  `--fg-danger`, `--fg-accent`. Dark keeps the 500 ramp values; light takes
  darker variants — and 0.9.1 deleted exactly these names with usable light
  values already in them (`#10794F`, `#7A4E06`, `#A62529`, `#473C9E`), so the
  git history is the starting point. Note the honest asymmetry: they were
  removed because nothing used them, and return because something will.
- Keep the tint recipe for the *surface* half. A 15 % tint of the fixed hue over
  white is a pale wash and works in both themes; only the text needed to move.
- Switch every unconditional status/accent **text** colour over. The surfaces,
  rings, fills and the waveform keep the ramps.
- A switch in Settings plus persistence in the JSON store (`settings`, which is
  where config-shaped state belongs), and `index.html` stops hardcoding the
  attribute.
- Extend the contrast measurement to a **test**, not a one-off script: every
  token pair the app actually renders, both themes, asserted against 4.5:1 for
  text and 3:1 for non-text. This is the finding that a document cannot hold —
  it needs arithmetic.

### 4. The scan announces its progress

The stage label updates for minutes inside a plain `<span>`
(`LibraryView.tsx:1752`). `role="status"` exists on the splash and the skeletons
but not on the thing that runs longest. Add a polite live region; make sure it
announces stage changes, not every percentage tick.

### 5. An `h1` on the primary view

One `h1` in the whole app (`BandcampView`), 13 `h2`, 2 `h3`. The library — the
main screen — starts at `h2`, and so does every modal. Give each view one `h1`
(visually hidden where the design has no room for it) and let the modals hang
below it correctly.

### 6. Checkboxes reach 24 px

`h-4 w-4` (16 px) at 13 sites, and the `<td>` stops the click, so the cell
padding is dead space and the target really is 16 × 16. WCAG 2.2 SC 2.5.8 (AA)
wants 24 × 24. Grow the box or make the padded cell the target — the second is
better, since the row already reads as clickable.

## P3

7. **`transition-all`** at `App.tsx:75` — on an element that also carries
   `backdrop-blur`, so it animates `filter` for 300 ms — and `HeaderNav.tsx:168`.
   Name the properties.
8. **The type ramp admits `10px`/`11px`** or gives them up. The detector's nine
   advisory findings are all this, and it is right: `DESIGN.md` describes the two
   steps in prose while its frontmatter has no role for them. Either add a
   `micro` role or fold the usages into `text-xs`.
9. **`scope="col"`** on the table's `<th>`.

## Order of work

P1 first and together — both are a11y and both want the same kind of
source-level guard. Then 3 (the largest), then 4–6, then the P3 batch. Each gets
its own commit; the guards land with the fix they guard.

## Verification

- The four gates green throughout: `npx tsc --noEmit`, `npm test`,
  `cd src-tauri && cargo check --tests` → 0, `cd src-tauri && cargo test`.
- New tests, not just fixes: the focus-suppression guard, the reduced-motion
  coverage guard, and the contrast assertion across both themes.
- `npm run tauri dev` and actually tab through the app — the focus work is the
  one item no test can confirm looks right.
- Re-run `$impeccable audit` at the end; a11y should move from 2 to 4 and
  theming from 3 to 4.
