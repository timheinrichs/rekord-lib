import { describe, expect, it } from "vitest";

import {
  classes,
  classNameExpressions,
  componentSources as sources,
} from "../test/classNames";
import { accent, graphite, status } from "./theme";

/**
 * Type, shape and colour rules from `docs/brand/STYLEGUIDE.md`, checked over the
 * source for the same reason `buttonShape.test.ts` is: every one of these
 * renders perfectly and is still wrong. All four were real drift found by
 * extracting `DESIGN.md` from the code — seven settings headings at weight 600,
 * four uppercase labels, ten text fields on the card radius, and a tempo marker
 * written in a colour that does not exist.
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

describe("styleguide rules over the source", () => {
  it("finds components and tokens to check", () => {
    // Guards the guards: a broken glob or a renamed token file would make
    // everything below vacuously pass.
    expect(sources.length).toBeGreaterThan(10);
    expect(TOKENS.has("accent-600")).toBe(true);
    expect(TOKENS.has("fg-muted")).toBe(true);
    // The defect this file was written for, as a positive control.
    expect(TOKENS.has("fg-warning")).toBe(false);
  });

  it("uses only the two weights", () => {
    // §4: 400 regular and 500 medium. Seven settings headings, one Bandcamp
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
    // §4: sentence case everywhere. `uppercase` shouts a value the user did not
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
    // §5: controls are `rounded-md` (8 px), cards `rounded-lg` (12 px). Ten
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
