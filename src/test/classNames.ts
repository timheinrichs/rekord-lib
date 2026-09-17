/**
 * The `className` text of every component, for the tests that check a
 * styleguide rule over the source rather than over a rendered component.
 *
 * Several rules in `docs/brand/STYLEGUIDE.md` cannot fail in a component test:
 * what goes wrong is a *new* element written next to the old ones with the
 * wrong height, weight or radius, and that element renders perfectly. So the
 * source itself is the subject, and this module is the one scanner all of those
 * tests share.
 */

// Vite inlines the sources at transform time, so this needs no filesystem access.
const modules = import.meta.glob("../**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every component source, as `[path, text]`, tests excluded. */
export const componentSources = Object.entries(modules).filter(
  ([path]) => !path.includes(".test."),
);

/**
 * The source text of every `className` value.
 *
 * Brace forms are read by counting braces to the matching close rather than by
 * matching delimiters with a regex. That is not pedantry: the first version
 * stopped at the first backtick it saw, and a comment *inside* a className
 * template literal happened to contain one — so the button that motivated the
 * conditional-colour rule was silently skipped by the rule meant to protect it.
 */
export function classNameExpressions(src: string): string[] {
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
export function split(expr: string): { always: string; branches: string } {
  const first = expr.indexOf("`");
  if (first === -1) return { always: expr, branches: "" };
  const tpl = expr.slice(first + 1, expr.lastIndexOf("`"));
  return {
    always: tpl.replace(/\$\{[\s\S]*?\}/g, " "),
    branches: [...tpl.matchAll(/\$\{([\s\S]*?)\}/g)].map((m) => m[1]).join(" "),
  };
}

/**
 * The individual utility classes in a className expression, with the `${…}`
 * holes flattened away — a conditional carries colours, never structure, and
 * reading into it would pick a token out of an expression.
 */
export function classes(expr: string): string[] {
  return expr
    .replace(/\$\{[^}]*\}/g, " ")
    .replace(/[`"'?:]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}
