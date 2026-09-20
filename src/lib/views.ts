/**
 * The top-level views, and the tabs that switch between them.
 *
 * Shaped like `GROUPINGS` in `lib/grouping.ts`, and here rather than in
 * `HeaderNav` for the same reason that one is not in the filter bar: four
 * modules need this vocabulary and only one of them is the nav. One of the four
 * is `test/appDom.ts`, which should not have to import a component to know what
 * the app's screens are called.
 *
 * The label is not decoration either — it is the view's accessible name in the
 * tab, and it is the name the view gives itself through `AppHeader`'s `title`,
 * which is what `appDom` narrows on. Keeping both from one table is what makes
 * renaming a view a single edit.
 */
export type MainView = "library" | "bandcamp";

/** In display order. */
export const VIEWS: readonly (readonly [MainView, string])[] = [
  ["library", "Library"],
  ["bandcamp", "Bandcamp"],
];

/** What a view calls itself — its tab, and its `AppHeader` title. */
export const VIEW_LABEL: Record<MainView, string> = Object.fromEntries(
  VIEWS,
) as Record<MainView, string>;
