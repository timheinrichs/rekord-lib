import { describe, expect, it } from "vitest";

import {
  applyTheme,
  resolveTheme,
  SYSTEM_LIGHT_QUERY,
  THEME_LABELS,
  type ThemePreference,
} from "./theme";

describe("resolveTheme", () => {
  it("takes an explicit choice at its word, whatever the system says", () => {
    for (const systemPrefersLight of [true, false]) {
      expect(resolveTheme("dark", systemPrefersLight)).toBe("dark");
      expect(resolveTheme("light", systemPrefersLight)).toBe("light");
    }
  });

  it("follows the system when asked to", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });

  it("resolves to dark when the system has no opinion", () => {
    // A platform that answers false to `prefers-color-scheme: light` has either
    // said dark or said nothing, and the app's default is dark either way.
    expect(resolveTheme("system", false)).toBe("dark");
  });

  it("only ever produces a theme tokens.css defines", () => {
    const prefs: ThemePreference[] = ["dark", "light", "system"];
    for (const p of prefs) {
      for (const light of [true, false]) {
        expect(["dark", "light"]).toContain(resolveTheme(p, light));
      }
    }
  });

  it("has a label for every preference, and asks the system for light", () => {
    expect(Object.keys(THEME_LABELS).sort()).toEqual([
      "dark",
      "light",
      "system",
    ]);
    expect(SYSTEM_LIGHT_QUERY).toBe("(prefers-color-scheme: light)");
  });
});

describe("applyTheme", () => {
  it("writes the theme onto the element", () => {
    const root = document.createElement("html");
    root.dataset.theme = "dark";
    applyTheme("light", root);
    expect(root.dataset.theme).toBe("light");
    applyTheme("dark", root);
    expect(root.dataset.theme).toBe("dark");
  });

  it("replaces the attribute rather than removing it", () => {
    // An absent attribute still reads as dark through the `:root` rule, so
    // removing it would make light a state the same mechanism cannot undo.
    const root = document.createElement("html");
    applyTheme("light", root);
    applyTheme("dark", root);
    expect(root.hasAttribute("data-theme")).toBe(true);
  });
});
