/**
 * Which of the two palettes is on screen, and why.
 *
 * Kept pure and separate from the applying, because the interesting part is a
 * three-into-two decision — dark, light, or whatever the system says — and that
 * is worth testing without a DOM.
 */

/** What the user chose. Not what is on screen: `system` resolves to one. */
export type ThemePreference = "dark" | "light" | "system";

/** What is actually on screen. `tokens.css` defines exactly these two. */
export type AppliedTheme = "dark" | "light";

export const THEME_LABELS: Record<ThemePreference, string> = {
  dark: "Dark",
  light: "Light",
  system: "System",
};

/**
 * The media query that answers for `system`. Light rather than dark, because
 * `prefers-color-scheme: light` is the explicit signal; a browser that supports
 * neither answers false to both and we want dark in that case, which is the
 * app's default anyway.
 */
export const SYSTEM_LIGHT_QUERY = "(prefers-color-scheme: light)";

/**
 * The palette to show. `systemPrefersLight` is passed in rather than read here
 * so this stays a function of its arguments — the caller owns the media query.
 */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersLight: boolean,
): AppliedTheme {
  if (preference === "system") return systemPrefersLight ? "light" : "dark";
  return preference;
}

/**
 * Writes the resolved theme onto `<html>`, which is where `tokens.css` reads it
 * (`:root, [data-theme="dark"]` versus `[data-theme="light"]`).
 *
 * `index.html` ships `data-theme="dark"` so the first paint is already styled;
 * this only ever replaces that value, never removes it — an absent attribute
 * would still be dark by the `:root` rule, but it would also mean the light
 * theme could never be undone by the same mechanism that set it.
 */
export function applyTheme(theme: AppliedTheme, root?: HTMLElement): void {
  (root ?? document.documentElement).dataset.theme = theme;
}
