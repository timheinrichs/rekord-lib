/**
 * Every button is the same height, and every button has the same corner.
 *
 * A source-scanning test rather than a rendering one, because the thing that
 * goes wrong is not a broken button — it is a new button written next to the
 * old ones with padding instead of a height. Padding cannot set a height: a
 * label is 20 px tall, an icon 16, so `py-2` and `p-2` produce 36 px and 34 px
 * from the same intention, and the row of controls steps up and down. That is
 * how the event log button ended up 34×34 while the buttons beside it were 36.
 *
 * The rule lives in `docs/brand/STYLEGUIDE.md` §5; this keeps it true.
 */
import { describe, expect, it } from "vitest";

// Vite's own glob rather than `node:fs`: the frontend tsconfig has no node
// types, and this is the same mechanism the app uses to reach static assets.
const SOURCES = import.meta.glob("./*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Opening `<button …>` tags. Attribute arrows (`=>`) are not the tag's end. */
const BUTTON = /<button\b.*?(?<!=)>/gs;
const CLASSNAME = /className=(?:"([^"]*)"|\{`(.*?)`\})/s;

interface Found {
  file: string;
  line: number;
  classes: string[];
}

function buttons(): Found[] {
  const out: Found[] = [];
  for (const [path, source] of Object.entries(SOURCES)) {
    const name = path.replace("./", "");
    if (name.includes(".test.")) continue;
    for (const match of source.matchAll(BUTTON)) {
      const found = CLASSNAME.exec(match[0]);
      const raw = found ? (found[1] ?? found[2] ?? "") : "";
      out.push({
        file: name,
        line: source.slice(0, match.index).split("\n").length,
        // `${…}` holds conditional colours, never sizing, and dropping it keeps
        // this from reading a token out of an expression.
        classes: raw.replace(/\$\{[^}]*\}/g, " ").split(/\s+/).filter(Boolean),
      });
    }
  }
  return out;
}

/**
 * A button that draws itself — a fill, an outline, or a padded box — as opposed
 * to a word inside a sentence that happens to be clickable. Those are type, not
 * controls, and giving them a 36 px box would turn a caption into a button.
 */
function isControl(classes: string[]): boolean {
  const boxed = classes.some(
    (c) => c.startsWith("bg-accent") || c.startsWith("border"),
  );
  const padded = classes.some((c) => c.startsWith("px-"));
  return boxed || padded;
}

const at = (b: Found) => `${b.file}:${b.line}`;

describe("every button is the same shape", () => {
  const all = buttons();

  it("finds the buttons at all", () => {
    // Guards the regex: a silent zero here would make every test below pass.
    expect(all.length).toBeGreaterThan(50);
  });

  it("states its height instead of deriving one from padding", () => {
    const wrong = all
      .filter((b) => isControl(b.classes))
      .filter((b) => !b.classes.includes("h-9"))
      .map(at);
    expect(wrong).toEqual([]);
  });

  it("never sets vertical padding, which is the other way to say a height", () => {
    const wrong = all
      .filter((b) => b.classes.some((c) => /^(py|p)-/.test(c)))
      .map(at);
    expect(wrong).toEqual([]);
  });

  it("uses the control radius, not the card radius", () => {
    // `rounded-full` stays legal: a pill and a circular transport button are
    // shapes, and forcing 8 px onto them would make them something else.
    const wrong = all
      .filter((b) => b.classes.includes("rounded-lg") || b.classes.includes("rounded-xl"))
      .map(at);
    expect(wrong).toEqual([]);
  });

  it("keeps icon-only buttons square", () => {
    const square = all.filter((b) => b.classes.includes("w-9"));
    expect(square.length).toBeGreaterThan(5);
    expect(square.filter((b) => !b.classes.includes("h-9")).map(at)).toEqual([]);
  });
});
