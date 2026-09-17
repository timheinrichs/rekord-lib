# Plan — close the styleguide drift

## Version

**PATCH: 0.9.0 → 0.9.1.** Nothing here is new to a user; every item is the app
being brought back to a rule it already claims to follow, plus one marker that
never rendered. Internal correctness and conformance — that is a PATCH at 0.x.

## Why now

`/impeccable document` extracted `DESIGN.md` from the running code and, in doing
so, listed five places where `docs/brand/STYLEGUIDE.md` and the implementation
disagree. Documenting a divergence is worth exactly as much as closing it, and
one of the five turned out to be a defect rather than a style question.

## The six items (plus one that turned out not to be one)

1. **Weights.** `font-semibold` (600) on ten headings against the two-weight
   rule (400/500) → `font-medium`.
2. **Caps.** Four `uppercase` labels against sentence case → dropped, together
   with the `tracking-wide` that came with two of them.
3. **`text-fg-warning` does not exist.** Two places mark an uncertain tempo with
   `text-fg-warning`, and `tokens.css` never defines `--color-fg-warning`, so
   the utility is not generated. The verdict inverted: an uncertain BPM rendered
   in the *brighter* inherited colour while a certain one stayed `fg-muted`.
   → `text-warning-500`, the colour the rest of the app uses for "still needs
   doing".
4. **Status surfaces.** `tokens.css` defines `--bg-warning`/`--fg-warning` pairs
   that nothing uses; the app builds every status surface as a 15 % tint with a
   30 % ring. Decision: documentation follows code — the pairs go, the styleguide
   recipe becomes the tint form. No visual change.
5. **Field radius.** Ten text fields at `rounded-lg` (12 px) beside buttons at
   `rounded-md` (8 px), and one field already at 8 px. Decision: all controls
   8 px, which is what the styleguide says and what puts the search field on the
   same corner as the buttons next to it.
6. **Type scale.** The styleguide names `text-xl`/`text-2xl` for titles; neither
   exists anywhere in the UI (`text-lg` is the largest). The document is wrong,
   not the code → the styleguide is corrected to the real scale.

## Guardrails

A source-scanning test in the spirit of `buttonShape.test.ts` and
`disabledStates.test.ts`, because none of these fails in a component test:
`src/styles/designRules.test.ts` asserts the two weights, sentence case, the
control radius, and — the general form of item 3 — that every semantic colour
utility a component writes actually exists as a token in `tokens.css`.

`DESIGN.md` and `.impeccable/design.json` are rewritten where they described the
drift as current, so the capture stays true.

## Documented rather than changed

**Card radius is two tiers, not one drift.** Reviewing the diff turned up
thirteen surfaces at `rounded-xl` (16 px) against fifteen at `rounded-lg`
(12 px), which looks like drift until you see which is which: the seven settings
sections, the empty states, the duplicate-group cards and the track-list shell
are page-level surfaces, and the twelve-pixel ones are menus, popovers and cards
sitting inside another panel. Bigger surface, bigger corner — a consistent rule
nobody had written down. So it is now written down in the styleguide, `DESIGN.md`
and the sidecar, and no component changed. Forcing seven settings sections onto
a smaller corner would have been an aesthetic change nobody asked for.

## Second topic — consolidate the design docs

Extracting `DESIGN.md` left the repo with two documents describing the same
visual system, and the drift above is what that costs. So authority moves to one
of them:

- `DESIGN.md` is binding for the visual system and says so in its own header,
  including that a `/impeccable document` refresh has to merge rather than
  overwrite, because the named rules and their reasons are not recoverable from
  tokens.
- `docs/brand/STYLEGUIDE.md` shrinks from 318 lines to 95: the logo, the brand
  assets, and the two setup mechanics (font packages, the `data-theme`
  attribute). Its stale `/logo` paths are corrected to `src/assets/brand/`.
- The copy-paste Tailwind recipes are **dropped** rather than moved. A recipe is
  a third copy of a component that already exists in code, and it is the copy
  nothing keeps honest; `DESIGN.md` now names the file each component is built
  in instead, since a pointer to living code cannot drift.
- Eleven references move — `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`,
  `PRODUCT.md`, `docs/README.md`, `docs/FUTURE_CONSIDERATIONS.md` — and the
  historical `CHANGELOG.md` entry is deliberately left alone.
- The tests stop citing section *numbers*. `buttonShape`, `designRules`,
  `disabledStates` and `classNames.ts` now name the rule they hold (the 36 px
  Rule, the Two Weights Rule, the Sentence Case Rule, the Opacity Rule), which a
  renamed section cannot orphan. `styleguideRules.test.ts` is renamed to
  `designRules.test.ts` for the same reason.
- `.claude/skills/frontend-design.md` and `design-design-system.md` are deleted
  and their paragraph in `CLAUDE.md` with them. The first was a generic
  "invent a distinctive identity, take an aesthetic risk" brief with a
  project-specific muzzle bolted on top — the muzzle carried the whole argument
  while the body worked against a fixed identity. The second was a third-party
  skill with no line of project context whose audit/document/extend is covered.
  The rule they existed to protect stays in `CLAUDE.md`, now without naming a
  tool.

Still open, not done here: `docs/brand/theme.ts` is a stale near-duplicate of
`src/styles/theme.ts` that nothing imports. The docs index now points at the
live file, which leaves the copy unreferenced; deleting it is the maintainer's
call.
