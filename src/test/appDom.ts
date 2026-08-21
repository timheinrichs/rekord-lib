/**
 * Narrowing a query to the view the app is actually showing.
 *
 * `App` keeps the library and the Bandcamp view mounted at all times and hides
 * one with Tailwind's `hidden` class, so a running scan or download survives
 * switching views. jsdom applies no stylesheet, so both are present and
 * queryable, and `screen.getByRole("button", { name: "Open settings" })` finds
 * two of them.
 *
 * These helpers narrow by position, which is stable because it is the order
 * `App` renders them in — library first, Bandcamp second — and they assert the
 * `hidden` class alongside, so a test that queries the library view while the
 * app is showing Bandcamp fails saying so rather than passing on the wrong
 * element.
 */
import { within } from "@testing-library/react";

function wrappers(container: HTMLElement): HTMLElement[] {
  // The two wrappers sit side by side under the app shell. They are picked out
  // by the header each view renders rather than by their class, because the
  // class is exactly what changes when the shown view changes — and the splash,
  // the other child at this level, has no header.
  const shell = container.querySelector<HTMLElement>("div.min-h-screen");
  if (!shell) return [];
  return Array.from(shell.children).filter((el): el is HTMLElement =>
    el instanceof HTMLElement && el.querySelector("header") !== null,
  );
}

function view(container: HTMLElement, index: number, name: string) {
  const found = wrappers(container)[index];
  if (!found) {
    throw new Error(
      `appDom: no ${name} view in the tree — is the app still on the splash?`,
    );
  }
  return found;
}

/** The library view, whether shown or hidden. */
export function libraryView(container: HTMLElement) {
  return within(view(container, 0, "library"));
}

/** The Bandcamp view, whether shown or hidden. */
export function bandcampView(container: HTMLElement) {
  return within(view(container, 1, "Bandcamp"));
}

/** Whether the app is currently showing the given view. */
export function isShown(container: HTMLElement, which: "library" | "bandcamp") {
  const found = view(container, which === "library" ? 0 : 1, which);
  return !found.classList.contains("hidden");
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
 */
export function overlay() {
  const all = document.querySelectorAll<HTMLElement>("div.fixed.inset-0.z-50");
  const top = all[all.length - 1];
  if (!top) throw new Error("appDom: no overlay on screen");
  return within(top);
}
