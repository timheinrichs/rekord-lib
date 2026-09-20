/**
 * Narrowing a query to one of the app's views.
 *
 * `App` keeps every main view mounted at all times and hides the inactive ones
 * with Tailwind's `hidden` class, so a running scan or download survives
 * switching views. jsdom applies no stylesheet, so all of them are present and
 * queryable, and `screen.getByRole("button", { name: "Open settings" })` finds
 * one per view.
 *
 * These helpers narrow by **the name a view gives itself** — the `sr-only`
 * `<h1>` that `AppHeader` renders from its `title`, of which there is exactly
 * one per screen by that component's own rule. They used to narrow by
 * position, "stable because it is the order `App` renders them in", and that
 * was only accidentally safe: inserting a view between two others re-points a
 * helper at the wrong element with no type error and nothing failing until a
 * dozen tests start disagreeing about what they are looking at. A name cannot
 * do that, and it makes reordering the tabs free.
 *
 * They assert the `hidden` class alongside, so a test that queries the library
 * while the app is showing Bandcamp fails saying so rather than passing on the
 * wrong element.
 */
import { within } from "@testing-library/react";

import { VIEW_LABEL, type MainView } from "../lib/views";

/**
 * The two surfaces that name themselves and are not tabs: the settings, and the
 * one track the player is on.
 */
const LABEL: Record<MainView | "settings" | "track", string> = {
  ...VIEW_LABEL,
  settings: "Settings",
  track: "Track",
};

function wrapper(container: HTMLElement, which: MainView | "settings" | "track") {
  const shell = container.querySelector<HTMLElement>("div.min-h-screen");
  const name = LABEL[which];
  const found = Array.from(shell?.children ?? []).filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement &&
      el.querySelector("header h1")?.textContent === name,
  );
  // Loud rather than arbitrary: the position version picked one silently.
  if (found.length > 1) {
    throw new Error(`appDom: two elements call themselves \u201C${name}\u201D`);
  }
  if (!found[0]) {
    throw new Error(
      `appDom: no ${name} view in the tree — is the app still on the splash?`,
    );
  }
  return found[0];
}

/** The library view, whether shown or hidden. */
export function libraryView(container: HTMLElement) {
  return within(wrapper(container, "library"));
}

/** The playlists view, whether shown or hidden. */
export function playlistsView(container: HTMLElement) {
  return within(wrapper(container, "playlists"));
}

/** The Bandcamp view, whether shown or hidden. */
export function bandcampView(container: HTMLElement) {
  return within(wrapper(container, "bandcamp"));
}

/** The track surface, which is only in the tree while it is open. */
export function trackView(container: HTMLElement) {
  return within(wrapper(container, "track"));
}

/** Whether the app is currently showing the given view. */
export function isShown(container: HTMLElement, which: MainView) {
  return !wrapper(container, which).classList.contains("hidden");
}

/**
 * The dialog on top.
 *
 * `Overlay` portals into `document.body`, so a modal is a sibling of the app
 * rather than part of it and cannot be reached through the render container.
 * More than one element matches the overlay's own classes — the boot splash
 * uses the same full-screen treatment — so this takes the last, which is what
 * "on top" means for stacked overlays.
 *
 * Scoping to it is not tidiness: the library table has a "Title" column header,
 * so an unscoped query for the editor's Title field finds two.
 *
 * `Toasts` deliberately stays out of this selector — anchored, `z-[60]`, never
 * `inset-0` — because a transient message wearing the overlay's classes would
 * be picked up here as "the dialog on top" in every flow test at once.
 */
export function overlay() {
  const all = document.querySelectorAll<HTMLElement>("div.fixed.inset-0.z-50");
  const top = all[all.length - 1];
  if (!top) throw new Error("appDom: no overlay on screen");
  return within(top);
}
