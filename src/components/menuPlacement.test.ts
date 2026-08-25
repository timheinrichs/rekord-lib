/**
 * Every menu opens downward, and above the header it hangs from.
 *
 * A source-scanning test, and a sibling of `buttonShape.test.ts`, because the
 * thing that goes wrong is not a broken menu — it is a menu written with the
 * placement that would have been right somewhere else. "Add to playlist" opened
 * *upward* (`bottom-full`) into a 64 px sticky header, so the panel sat off the
 * top of the window and could not be clicked at all; it also carried `z-30`,
 * which is the header's own layer rather than a layer over it.
 *
 * Both are invisible in a unit test and in every flow test: the panel is in the
 * DOM, its buttons are found by role, and `userEvent` clicks them happily. Only
 * a person looking at the window can see it, which is exactly the kind of rule
 * worth pinning in the source.
 */
import { describe, expect, it } from "vitest";

// Vite's own glob rather than `node:fs`, as in `buttonShape.test.ts`: the
// frontend tsconfig has no node types.
const SOURCES = import.meta.glob("./*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** The header these menus hang from — `AppHeader` is `sticky top-0 z-30`. */
const HEADER_LAYER = 30;

interface Panel {
  file: string;
  line: number;
  classes: string[];
}

/**
 * Absolutely positioned panels: a popover, a dropdown, a menu. Anything that
 * is `absolute` and sets its own layer is one of these; the small decorations
 * that are merely `absolute` (a badge, a caret) are not, and are left alone.
 */
function panels(): Panel[] {
  const out: Panel[] = [];
  for (const [path, source] of Object.entries(SOURCES)) {
    const name = path.replace("./", "");
    if (name.includes(".test.")) continue;
    for (const match of source.matchAll(/className="([^"]*)"/g)) {
      const classes = match[1].split(/\s+/).filter(Boolean);
      if (!classes.includes("absolute")) continue;
      if (!classes.some((c) => /^z-\d+$/.test(c))) continue;
      out.push({
        file: name,
        line: source.slice(0, match.index).split("\n").length,
        classes,
      });
    }
  }
  return out;
}

const at = (p: Panel) => `${p.file}:${p.line}`;
const layerOf = (p: Panel) =>
  Number(p.classes.find((c) => /^z-\d+$/.test(c))!.slice(2));

describe("every menu opens the same way", () => {
  const all = panels();

  it("finds the panels at all", () => {
    // Guards the scan: a silent zero here would make every test below pass.
    expect(all.length).toBeGreaterThan(3);
  });

  it("opens downward, because the actions live in the header", () => {
    // `bottom-full` puts the panel above its trigger. For a control in the
    // header that is off the top of the window — there is nothing up there to
    // open into. A menu anchored somewhere else may earn the exception; it has
    // to be argued for here rather than written silently.
    const wrong = all.filter((p) => p.classes.includes("bottom-full")).map(at);
    expect(wrong).toEqual([]);
  });

  it("sits above the header rather than in it", () => {
    // Same layer as the header is not "over the header": it leaves the outcome
    // to document order, which is not a decision anyone made.
    const wrong = all
      .filter((p) => p.classes.includes("top-full"))
      .filter((p) => layerOf(p) <= HEADER_LAYER)
      .map(at);
    expect(wrong).toEqual([]);
  });
});
