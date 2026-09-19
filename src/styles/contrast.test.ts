/**
 * The contrast of every colour pair the app actually renders, in both themes.
 *
 * This exists because a document cannot hold it. `DESIGN.md` can say "plenty of
 * contrast on small text" and be believed for two releases while
 * `warning-500` sits at 1.9:1 on a light surface — which is exactly what
 * happened, and it was only found by doing the arithmetic. So the arithmetic
 * lives here, over the values `tokens.css` actually ships.
 *
 * Thresholds are WCAG 2.1 AA: 4.5:1 for text, 3:1 for the non-text visual
 * information that identifies a control (SC 1.4.11).
 */
import { describe, expect, it } from "vitest";

// Readable because `vite.config.ts` sets `test.css`; see designRules.test.ts.
import tokensCss from "./tokens.css?raw";

/** Relative luminance, WCAG 2.x definition. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const ch = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const lin = ch.map((v) =>
    v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Flatten a translucent colour onto an opaque one, as the compositor would. */
function over(fg: string, bg: string, alpha: number): string {
  const px = (hex: string) =>
    [0, 2, 4].map((i) => parseInt(hex.replace("#", "").slice(i, i + 2), 16));
  const [f, b] = [px(fg), px(bg)];
  const mix = f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)));
  return `#${mix.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The custom properties of one theme block, read from the stylesheet rather
 * than mirrored here — a second copy of a colour is how this class of bug
 * starts.
 */
function theme(selector: string): Record<string, string> {
  const start = tokensCss.indexOf(selector);
  if (start === -1) throw new Error(`no ${selector} block in tokens.css`);
  const block = tokensCss.slice(start, tokensCss.indexOf("}", start));
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6})/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );
}

/** The fixed ramps, for the tints a status surface is built from. */
const RAMP = {
  "success-500": "#22B27A",
  "warning-500": "#F5A623",
  "danger-500": "#E5484D",
  "accent-600": "#574BC0",
  "accent-500": "#6A5FD6",
  "danger-600": "#D13239",
} as const;

/**
 * The opaque fills the app puts a label on, with the label it uses.
 *
 * This table is the part of the file that was missing, and its absence is how a
 * near-black label on dark violet shipped: the tests asserted text on the three
 * *surfaces* and on translucent tints, and a solid ramp fill is neither. A fill
 * does not move with the theme, so the label on it is fixed — and that is the
 * assertion.
 */
const LABELLED_FILLS = [
  { fill: "accent-600", label: "#FFFFFF", what: "the primary action" },
  { fill: "accent-500", label: "#FFFFFF", what: "the primary action, hovered" },
  { fill: "danger-600", label: "#FFFFFF", what: "the destructive action" },
] as const;

const THEMES = {
  dark: theme(':root,\n[data-theme="dark"]'),
  light: theme('[data-theme="light"]'),
};

/**
 * Deliberately not asserted, with the reason, so an exclusion is a decision
 * rather than an oversight:
 *
 * - `fg-disabled` — WCAG exempts inactive components from contrast entirely,
 *   and the whole point of the token is to read as unavailable.
 * - `border` / `border-strong` — the hairlines measure 1.1–2.0:1 against their
 *   surfaces, which is below SC 1.4.11's 3:1 for the visual information that
 *   identifies a control. That is the "quiet until touched" identity in
 *   `DESIGN.md` colliding with a conformance rule, it is an open question
 *   rather than a settled exclusion, and raising the hairline changes how every
 *   control in the app looks. Recorded here so the next person finds the
 *   measurement instead of re-deriving it.
 */
const NOT_ASSERTED = ["fg-disabled", "border", "border-strong"];

describe("contrast, in both themes", () => {
  it("reads both theme blocks out of tokens.css", () => {
    // Guards the guards: a renamed selector would make everything below vacuous.
    for (const [name, t] of Object.entries(THEMES)) {
      expect(Object.keys(t).length, name).toBeGreaterThan(8);
      expect(t.bg, name).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(t["fg-warning"], name).toBeDefined();
    }
    expect(NOT_ASSERTED).toContain("border-strong");
  });

  it.each(LABELLED_FILLS)(
    "$what reads on its own fill, in both themes at once",
    ({ fill, label }) => {
      // One assertion for both themes on purpose: the fill and the label are
      // both fixed, so there is one number and it holds everywhere. A label
      // that needed a theme would be the defect.
      const r = ratio(label, RAMP[fill]);
      expect(r, `${label} on ${fill} is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        4.5,
      );
    },
  );

  it("keeps a themed text token off a fixed fill", () => {
    // The measurement behind the rule, kept next to it: `--fg` is the label
    // colour a fill inherits if nothing says otherwise, and on `accent-600` it
    // is fine on dark and 2.9:1 on light. Recorded so the rule reads as a
    // consequence rather than a preference.
    expect(ratio(THEMES.dark.fg, RAMP["accent-600"])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(THEMES.light.fg, RAMP["accent-600"])).toBeLessThan(4.5);
  });

  const surfaces = ["bg", "surface", "surface-2"] as const;
  const textTokens = [
    "fg",
    "fg-muted",
    "fg-subtle",
    "fg-success",
    "fg-warning",
    "fg-danger",
    "fg-accent",
  ] as const;

  for (const [themeName, t] of Object.entries(THEMES)) {
    describe(themeName, () => {
      it.each(textTokens)("%s reads on every surface", (token) => {
        for (const surface of surfaces) {
          const r = ratio(t[token], t[surface]);
          expect(
            r,
            `${token} on ${surface} is ${r.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      });

      it("status text reads on its own 15 % tint", () => {
        // The pill recipe: a 15 % wash of the ramp hue, the solid text on top.
        const pairs = [
          ["fg-success", RAMP["success-500"]],
          ["fg-warning", RAMP["warning-500"]],
          ["fg-danger", RAMP["danger-500"]],
          ["fg-accent", RAMP["accent-600"]],
        ] as const;
        for (const [token, hue] of pairs) {
          for (const surface of ["surface", "surface-2"] as const) {
            const tint = over(hue, t[surface], 0.15);
            const r = ratio(t[token], tint);
            expect(
              r,
              `${token} on its tint over ${surface} is ${r.toFixed(2)}:1`,
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
      });

      it("the active tab label reads on its wash", () => {
        // A 20 % accent-600 wash, which is the one place a label sits on colour.
        const wash = over(RAMP["accent-600"], t.surface, 0.2);
        const r = ratio(t["fg-accent"], wash);
        expect(r, `fg-accent on the tab wash is ${r.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      });

      it("the focus ring is visible on every surface", () => {
        // Non-text: SC 1.4.11's 3:1. The ring sits on the page because of its
        // offset, so the surface behind the control is what it must clear.
        for (const surface of surfaces) {
          const r = ratio(t.focus, t[surface]);
          expect(
            r,
            `focus on ${surface} is ${r.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(3);
        }
      });
    });
  }
});

/**
 * The three surface tones against each other — the measurement The Well Rule
 * rests on.
 *
 * Everything above asks whether something *reads*. This asks the opposite, and
 * records a set of numbers that are all far below any threshold: the steps
 * between the tones are between 1.06 and 1.18 to one. That is the point. A
 * tone step in this palette cannot carry a signal across a single 64 px row,
 * which is why an open group read as closed, and why the answer was to move a
 * whole block rather than to find a better shade. Kept here so the rule is a
 * consequence of an arithmetic anyone can re-run, not a preference.
 *
 * Nothing here checks that text still reads in the well: `bg` is one of the
 * three surfaces every text token is already measured against above, so moving
 * rows onto it needed no new assertion. Worth saying, because "the rows are on
 * a different background now" is otherwise exactly the change you would go
 * looking for cover on.
 */
describe("the table's three tones", () => {
  const step = (t: Record<string, string>, a: string, b: string) =>
    ratio(t[a], t[b]);

  it.each(Object.entries(THEMES))("%s has three distinct tones", (_n, t) => {
    // Guards the well itself: collapse two of these into one value and the
    // expanded group silently stops being visible at all.
    expect(new Set([t.bg, t.surface, t["surface-2"]]).size).toBe(3);
  });

  it.each(Object.entries(THEMES))(
    "%s: no pair of tones is further apart than 1.2:1",
    (name, t) => {
      // The upper bound is the interesting direction. If a future edit made a
      // tone step genuinely legible on one row, The Well Rule would have lost
      // its reason and should be re-argued rather than quietly kept.
      for (const [a, b] of [
        ["surface", "surface-2"],
        ["surface", "bg"],
        ["bg", "surface-2"],
      ] as const) {
        const r = step(t, a, b);
        expect(r, `${name}: ${a} to ${b} is ${r.toFixed(3)}:1`).toBeLessThan(1.2);
      }
    },
  );

  it("records which way the hover step moves inside a well", () => {
    // Asserted on dark, recorded on light, in the style of the fixed-fill
    // measurement above: hovering a row that sits in the well is the largest
    // step in the dark table and the smallest in the light one. The well is
    // still worth having on light — it is carried by the block's edges, not by
    // this number — but the honest value belongs next to the claim.
    expect(step(THEMES.dark, "bg", "surface-2")).toBeGreaterThan(
      step(THEMES.dark, "surface", "surface-2"),
    );
    expect(step(THEMES.light, "bg", "surface-2")).toBeLessThan(
      step(THEMES.light, "surface", "surface-2"),
    );
  });
});
