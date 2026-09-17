import { describe, expect, it } from "vitest";

import {
  classes,
  classNameExpressions,
  componentSources as sources,
} from "../test/classNames";
import { accent, graphite, status } from "./theme";
// Readable only because `vite.config.ts` sets `test.css` — Vitest stubs CSS
// imports to an empty string otherwise, `?raw` included.
import indexCss from "../index.css?raw";

/**
 * Type, shape and colour rules from `DESIGN.md`, checked over the source for the
 * same reason `buttonShape.test.ts` is: every one of these renders perfectly and
 * is still wrong. All four were real drift found by extracting that document from
 * the code — seven settings headings at weight 600, four uppercase labels, ten
 * text fields on the card radius, and a tempo marker written in a colour that
 * does not exist.
 *
 * Each test below names the rule it holds, so a renamed section cannot quietly
 * orphan the reference the way a section *number* did.
 */

/** Utility prefixes that take a colour. */
const COLOR_PREFIX = /^(?:text|bg|border|ring|divide|fill|stroke|outline|shadow|from|via|to)-/;

/**
 * The token families in `tokens.css`. A class whose colour starts with one of
 * these is ours to check; `text-white`, `bg-black/60` and `border-transparent`
 * are Tailwind's own and are left alone.
 */
const FAMILIES = new Set([
  "accent",
  "graphite",
  "success",
  "warning",
  "danger",
  "info",
  "bg",
  "surface",
  "border",
  "fg",
]);

/**
 * Every colour token `tokens.css` generates a utility for.
 *
 * The ramps come from `theme.ts`, which is the same values as the `@theme`
 * block by construction. The nine semantic aliases are listed here because
 * `tokens.css` itself cannot be read from a test — Vitest stubs CSS imports to
 * an empty string, `?raw` included. So a *new* semantic token has to be added
 * to this list as well; the failure says which class it was and the fix is one
 * line, which is a cheaper trade than a mirror nobody notices going stale.
 */
const TOKENS = new Set([
  ...Object.keys(accent).map((k) => `accent-${k}`),
  ...Object.keys(graphite).map((k) => `graphite-${k}`),
  ...Object.keys(status).map((k) => `${k}-500`),
  "bg",
  "surface",
  "surface-2",
  "border",
  "border-strong",
  "fg",
  "fg-muted",
  "fg-subtle",
  "fg-disabled",
  "focus",
  // The status/accent *text* weights, theme-dependent because the fixed ramps
  // cannot serve both themes as type. See tokens.css.
  "fg-success",
  "fg-warning",
  "fg-danger",
  "fg-accent",
]);

/** Strips variants (`hover:`, `enabled:hover:`, `md:`) and an alpha suffix. */
function colorName(cls: string): string | null {
  const bare = cls.slice(cls.lastIndexOf(":") + 1);
  if (!COLOR_PREFIX.test(bare)) return null;
  const value = bare.slice(bare.indexOf("-") + 1).split("/")[0];
  if (!value || value.startsWith("[")) return null;
  return FAMILIES.has(value.split("-")[0]) ? value : null;
}

/** Opening `<input>` / `<select>` / `<textarea>` tags. `=>` is not a tag end. */
const FIELD = /<(?:input|select|textarea)\b.*?(?<!=)>/gs;
/**
 * A tick box is not a text field. A checkbox and a radio are 14 px squares that
 * carry no text, and an 8 px corner on a 14 px box is a circle — they keep
 * Tailwind's own small `rounded`, which is the shape they have today.
 */
const TICK = /type=\{?"(?:checkbox|radio)"/;
const CLASSNAME = /className=(?:"([^"]*)"|\{`(.*?)`\})/s;

describe("design system rules over the source", () => {
  it("finds components and tokens to check", () => {
    // Guards the guards: a broken glob or a renamed token file would make
    // everything below vacuously pass.
    expect(sources.length).toBeGreaterThan(10);
    expect(TOKENS.has("accent-600")).toBe(true);
    expect(TOKENS.has("fg-muted")).toBe(true);
    // A positive control: a name that looks like a token and is not one, so the
    // lookup below is known to be capable of saying no. It used to be
    // `fg-warning` — the utility whose absence made an uncertain tempo render
    // brighter than a sure one — but 0.9.2 made that a real token, for the
    // theme reason in tokens.css. `bg-warning` is the half of the deleted pair
    // that stayed deleted: the surfaces are built as a tint of the ramp.
    expect(TOKENS.has("bg-warning")).toBe(false);
  });

  it("uses only the two weights", () => {
    // The Two Weights Rule: 400 regular and 500 medium. Seven settings
    // headings, one Bandcamp
    // heading and two duplicate-group headings had drifted to 600, which reads
    // as a third level of hierarchy the system does not have.
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const expr of classNameExpressions(src)) {
        for (const cls of classes(expr)) {
          if (/^font-(?:semibold|bold|extrabold|black|light|thin)$/.test(cls)) {
            offenders.push(`${path}: ${cls}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("writes sentence case, never caps", () => {
    // The Sentence Case Rule: everywhere. `uppercase` shouts a value the user did not
    // type — two of these were on data (`item_type`), which arrives lowercase
    // and should be shown that way.
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const expr of classNameExpressions(src)) {
        if (classes(expr).includes("uppercase")) offenders.push(path);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives every text field the control radius", () => {
    // `DESIGN.md` → Shapes: controls are `rounded-md` (8 px), a nested or
    // floating panel `rounded-lg` (12 px), a page-level section `rounded-xl`. Ten
    // fields sat on the card radius next to buttons on the control one, which
    // put two corners in the same toolbar.
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const match of src.matchAll(FIELD)) {
        if (TICK.test(match[0])) continue;
        const found = CLASSNAME.exec(match[0]);
        const raw = found ? (found[1] ?? found[2] ?? "") : "";
        const cls = classes(raw);
        const radius = cls.filter((c) => c.startsWith("rounded"));
        if (!radius.length) continue; // an unstyled field inherits its shape
        const line = src.slice(0, match.index).split("\n").length;
        if (radius.some((r) => r !== "rounded-md" && r !== "rounded-full")) {
          offenders.push(`${path}:${line}: ${radius.join(" ")}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("leaves the focus ring to the base layer", () => {
    // `index.css` gives everything focusable one `:focus-visible` ring, and it
    // is unlayered so no utility can outrank it — except an `outline-*`
    // utility on the element itself, which is exactly what suppressed focus
    // everywhere before 0.9.2: sixteen `outline-none` classes and no
    // replacement. A component that wants to opt out has to argue for it here.
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const expr of classNameExpressions(src)) {
        for (const cls of classes(expr)) {
          if (/^(?:[a-z-]+:)*outline-(?:none|0)$/.test(cls)) {
            offenders.push(`${path}: ${cls}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("switches off every animation under reduced motion", () => {
    // The block in `index.css` used to name four animations, so Tailwind's own
    // `animate-spin` and `animate-pulse` — the two infinite ones — kept running
    // for a user who had asked for no motion. It now matches `[class*=
    // "animate-"]`, and this asserts that the selector still covers everything
    // the tree actually uses, including a future utility nobody adds to a list.
    const used = new Set<string>();
    for (const [, src] of sources) {
      for (const expr of classNameExpressions(src)) {
        for (const cls of classes(expr)) {
          if (/^animate-/.test(cls) && cls !== "animate-none") used.add(cls);
        }
      }
    }
    // Guards the guard: a broken scan would make the assertion vacuous.
    expect(used.size).toBeGreaterThan(3);

    const block = indexCss.slice(indexCss.indexOf("prefers-reduced-motion"));
    const generic = /\[class\*=("|')animate-\1\]\s*\{[^}]*animation:\s*none/.test(
      block,
    );
    const uncovered = generic
      ? []
      : [...used].filter((c) => !block.includes(`.${c}`));
    expect(uncovered).toEqual([]);
  });

  it("only writes colour utilities that tokens.css defines", () => {
    // The general form of a defect this file was written for: two places marked
    // an uncertain tempo `text-fg-warning`, `tokens.css` defines no
    // `--color-fg-warning`, so Tailwind generated nothing and the cell inherited
    // the *brighter* default — an uncertain value looked more certain than a
    // sure one. A missing utility is silent, so nothing but a check finds it.
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const expr of classNameExpressions(src)) {
        for (const cls of classes(expr)) {
          const name = colorName(cls);
          if (name && !TOKENS.has(name)) offenders.push(`${path}: ${cls}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
