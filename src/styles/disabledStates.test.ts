import { describe, expect, it } from "vitest";

/**
 * Guards the styleguide rules about non-interactive states
 * (docs/brand/STYLEGUIDE.md → "Colors"). All three were regressions found in the
 * running app rather than hypotheticals, and none shows up in a unit test of any
 * single component — so they are checked over the source itself.
 */

// Vite inlines the sources at transform time, so this needs no filesystem access.
const modules = import.meta.glob("../**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const sources = Object.entries(modules).filter(
  ([path]) => !path.includes(".test."),
);

/**
 * The source text of every `className` value.
 *
 * Brace forms are read by counting braces to the matching close rather than by
 * matching delimiters with a regex. That is not pedantry: the first version
 * stopped at the first backtick it saw, and a comment *inside* a className
 * template literal happened to contain one — so the button that motivated the
 * third rule below was silently skipped by the rule meant to protect it.
 */
function classNameExpressions(src: string): string[] {
  const out: string[] = [];
  const re = /className=(?:"([^"]*)"|\{)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(src)) !== null) {
    if (match[1] !== undefined) {
      out.push(match[1]);
      continue;
    }
    let depth = 1;
    let i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    out.push(src.slice(re.lastIndex, i - 1));
    re.lastIndex = i;
  }
  return out;
}

/**
 * Splits a className expression into what it always applies and what it applies
 * conditionally. Taking the first and last backtick spans the whole template
 * literal, so a stray backtick inside it cannot cut the analysis short.
 */
function split(expr: string): { always: string; branches: string } {
  const first = expr.indexOf("`");
  if (first === -1) return { always: expr, branches: "" };
  const tpl = expr.slice(first + 1, expr.lastIndexOf("`"));
  return {
    always: tpl.replace(/\$\{[\s\S]*?\}/g, " "),
    branches: [...tpl.matchAll(/\$\{([\s\S]*?)\}/g)].map((m) => m[1]).join(" "),
  };
}

describe("disabled states", () => {
  it("finds components to check", () => {
    // Guards the guard: a broken glob would make everything below vacuously pass.
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some(([path]) => path.includes("LibraryView"))).toBe(true);
    const scanButton = sources
      .flatMap(([, src]) => classNameExpressions(src))
      .some((expr) => expr.includes("border-success-500"));
    expect(scanButton).toBe(true);
  });

  it("never expresses disabled with opacity", () => {
    // Opacity multiplies with the content's own colour, so the same state came
    // out a different grey on an outlined button, a filled one and an icon
    // button. `text-fg-disabled` says it once.
    const offenders = sources
      .filter(([, src]) => /disabled:opacity-/.test(src))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("guards hover styles on anything that can be disabled", () => {
    // `:hover` still matches a disabled button, so an unguarded hover lights it
    // up as though it were clickable.
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const expr of classNameExpressions(src)) {
        if (!expr.includes("disabled:")) continue;
        const unguarded = expr.match(
          /(?<!enabled:)(?<!group-)(?<!peer-)\bhover:[\w:/[\].-]*/g,
        );
        if (unguarded) offenders.push(`${path}: ${unguarded.join(", ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps a disabled override out of a conditional status colour", () => {
    // A `disabled:` variant is a class plus a pseudo-class, so it outranks a
    // bare status colour. With the override applied unconditionally and the
    // status colour only in a branch, the scan button's "finished" label and
    // icon stayed grey inside an already-green outline until the button happened
    // to re-enable.
    //
    // A status colour that is *always* applied alongside a disabled override is
    // a different thing and stays allowed: a warning-coloured button is supposed
    // to look disabled when it is disabled.
    const offenders: string[] = [];
    for (const [path, src] of sources) {
      for (const expr of classNameExpressions(src)) {
        const { always, branches } = split(expr);
        for (const prop of ["text", "border", "bg"]) {
          const overridden = new RegExp(`\\bdisabled:${prop}-`).test(always);
          const status = new RegExp(
            `\\b${prop}-(success|warning|danger|info)-`,
          ).test(branches);
          if (overridden && status) {
            offenders.push(
              `${path}: disabled:${prop}-* outranks a conditional ${prop} status colour`,
            );
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
