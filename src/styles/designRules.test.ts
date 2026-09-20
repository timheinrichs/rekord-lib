import { describe, expect, it } from "vitest";

import {
  allSources,
  classes,
  classNameExpressions,
  componentSources as sources,
  split,
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
  // The destructive fill; see tokens.css.
  "danger-600",
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
 *
 * A range needs no exemption: it writes no radius at all, and the rule below
 * already leaves an unstyled field alone. Exempting it would have let the next
 * one arrive on the card radius unnoticed.
 */
const TICK = /type=\{?"(?:checkbox|radio)"/;
/** A slider, among the fields `FIELD` found. */
const RANGE = /type=\{?"range"/;
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

  it("draws a range in our accent, not the system's", () => {
    // The One Accent Rule, in the one place the platform will break it for
    // free: an unstyled `<input type="range">` renders its filled track and
    // thumb in the *macOS* accent colour, which is whatever the user picked in
    // System Settings — blue, pink, graphite. That is a second brand colour on
    // screen, chosen by nobody here. `accent-accent-500` is the waveform violet
    // the rest of the app signals with.
    const offenders: string[] = [];
    let found = 0;
    for (const [path, src] of sources) {
      for (const match of src.matchAll(FIELD)) {
        if (!RANGE.test(match[0])) continue;
        found++;
        const cls = CLASSNAME.exec(match[0]);
        const raw = cls ? (cls[1] ?? cls[2] ?? "") : "";
        if (classes(raw).includes("accent-accent-500")) continue;
        const line = src.slice(0, match.index).split("\n").length;
        offenders.push(`${path}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
    // Guards the guard: a regex that matches nothing passes this vacuously,
    // and then so does the radius exemption it pays for.
    expect(found).toBeGreaterThan(0);
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

  it("puts a fixed label on a fixed fill", () => {
    // The bug this is here for shipped in 0.9.2 and was found by looking at the
    // app: a primary button is `bg-accent-600` and its label was `text-fg`,
    // which is theme-dependent — so in light mode a near-black label sat on
    // dark violet at 2.9:1. A fill from the ramp does not move with the theme,
    // so its label must not either. Inheriting is the same mistake with no
    // class to point at, which is why a bare fill counts as an offender.
    const SOLID = /^bg-(?:accent|danger|success|warning|info)-\d00$/;
    const THEMED_TEXT = /^text-(?:fg|fg-muted|fg-subtle|fg-accent|fg-success|fg-warning|fg-danger)$/;
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const expr of classNameExpressions(src)) {
        const cls = classes(expr);
        // Only opaque fills: a `/15` tint composites over the theme's surface
        // and a theme-dependent label is right on top of it.
        if (!cls.some((c) => SOLID.test(c))) continue;
        // And only fills that carry type. A notification dot, a progress bar
        // and a waveform are accent-filled and hold no text, so a label colour
        // would mean nothing on them. The proxy is a type size or horizontal
        // padding, which every labelled control in this app has and none of the
        // bare fills do. It is a proxy: an element whose text comes entirely
        // from a child would slip through, and that is the known hole.
        const carriesType =
          cls.some((c) => /^text-(xs|sm|base|lg|xl|\[\d+px\])$/.test(c)) ||
          cls.some((c) => /^px-/.test(c));
        if (!carriesType) continue;
        const fixed = cls.some(
          (c) => c === "text-white" || c === "text-black" || c.startsWith("text-graphite-"),
        );
        const themed = cls.filter((c) => THEMED_TEXT.test(c));
        if (themed.length) {
          offenders.push(`${path}: ${themed.join(" ")} on a fixed fill`);
        } else if (!fixed) {
          offenders.push(`${path}: a fixed fill with no label colour of its own`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not blur behind a surface you cannot see through", () => {
    // A `backdrop-filter` re-samples and re-blurs everything beneath it on
    // every frame the content moves. Behind an opaque or nearly opaque
    // background that work produces nothing visible, and it is not free: the
    // sticky header and the filter bar both added `backdrop-blur` at the same
    // scroll threshold, over a full-width virtualized table, and scrolling
    // stuttered from the moment they docked. The player bar paid the same cost
    // permanently, behind 95 % opacity, to show five per cent.
    //
    // 80 % is the line. Below it the blur is doing visible work — the Bandcamp
    // cover badge at `bg-black/60` sits over a still image and keeps it.
    // Scanned per string literal rather than per className, because a docked
    // state lives inside a `${cond ? "…" : "…"}` and the two branches describe
    // two different surfaces. `classes()` flattens those holes away — which is
    // right for every other rule here and wrong for this one, and is why the
    // first version of this test passed while the blur was still in the file.
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const expr of classNameExpressions(src)) {
        for (const literal of expr.split(/["'`]/)) {
          const cls = literal.split(/\s+/).filter(Boolean);
          if (!cls.some((c) => c.startsWith("backdrop-blur"))) continue;
          for (const bg of cls.filter((c) => /^bg-/.test(c))) {
            const alpha = bg.includes("/") ? Number(bg.split("/")[1]) : 100;
            if (!Number.isNaN(alpha) && alpha >= 80) {
              offenders.push(`${path}: backdrop-blur behind ${bg}`);
            }
          }
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

  it("never writes a resting state in the hover tone", () => {
    // The Well Rule's guard, and the general form of the defect it was written
    // for. `surface-2` means *the pointer is here*; an element that also rests
    // on it has two states that look the same, and the one you lose is the one
    // you were trying to show. The fix is always the other direction — down to
    // `bg`, the well — never a lighter shade, because there is nothing above
    // `surface-2` to move to.
    //
    // A tint (`bg-surface-2/40`, the closed group head) is a different tone and
    // is deliberately allowed; only the full value collides.
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const expr of classNameExpressions(src)) {
        if (!expr.includes("hover:bg-surface-2")) continue;
        const { always, branches } = split(expr);
        const bare = [always, branches, expr.includes("`") ? "" : expr]
          .join(" ")
          .split(/[\s`"'{}()?]+/)
          .filter((t) => t === "bg-surface-2");
        if (bare.length) offenders.push(`${path}: ${expr.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ends a label in an ellipsis only while it is running", () => {
    // The No-Ellipsis Rule. `…` on a control says one thing — *this is
    // happening right now* — and the desktop-menu sense of "opens a dialog" is
    // borrowed from a world where the neighbouring item might not. Here they
    // all do, so it marks nothing and only lengthens the label.
    //
    // Read off the first word, because the label's *end* cannot tell the two
    // apart: "Searching for suggestions…" is progress and "Choose folder…" is
    // not, and both end in a noun. A progress label starts with the verb.
    //
    // Scanned by line rather than by parsing literals, so that JSX text
    // (`New playlist…` written as a child) is held to the rule as well as a
    // string — and over every source, not only components, because `boot.ts`
    // is where four of the app's labels live.
    const offenders: string[] = [];
    for (const [path, src] of allSources) {
      for (const line of src.split("\n")) {
        const code = line.trim();
        if (/^(\/\/|\/\*|\*)/.test(code)) continue;
        for (let i = line.indexOf("…"); i >= 0; i = line.indexOf("…", i + 1)) {
          // Only where the label *ends*. A `…` in the middle of one is prose,
          // and holding prose to a rule about titles is how a design test
          // starts failing for something it was never about.
          if (!/^\s*(?:["'`<]|$)/.test(line.slice(i + 1))) continue;
          // Back to whatever opened the label: a quote, a backtick, or the
          // `>` that closes the tag a JSX child follows.
          const start = Math.max(
            ...['"', "'", "`", ">"].map((c) => line.lastIndexOf(c, i - 1)),
          );
          const label = line.slice(start + 1, i).trim();
          // A label that *begins* with an interpolation has its first word at
          // runtime — `${scan.stage}…` — and is left to its source. One that
          // merely contains one further along is not exempt.
          if (label.startsWith("${")) continue;
          const first = label.split(/\s+/)[0] ?? "";
          if (/^[A-Za-z]/.test(first) && !/ing$/i.test(first)) {
            offenders.push(`${path}: ${code}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
