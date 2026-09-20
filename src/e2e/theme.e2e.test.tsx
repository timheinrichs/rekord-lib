/**
 * The theme setting, from the click to the attribute on `<html>`.
 *
 * A flow test rather than a component test, because the interesting part spans
 * three pieces that a mock would hide: `SettingsView` only stores the choice,
 * `settings.ts` persists it through the store plugin, and `App.tsx` is the one
 * that resolves it and writes `data-theme` — which is what `tokens.css` reads.
 * A component test of the section can prove the button calls back and nothing
 * more; it cannot prove the app changed colour.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { libraryView } from "../test/appDom";
import { makeTrack } from "../test/factories";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";

const LIBRARY = "/fixture/library";

let fake: FakeBackend;

beforeEach(() => {
  fake = installFakeBackend({
    files: [`${LIBRARY}/a.aiff`],
    tracks: [makeTrack({ path: `${LIBRARY}/a.aiff` })],
    store: { settings: { library_dir: LIBRARY } },
  });
});

afterEach(() => {
  cleanup();
  fake.restore();
  // The attribute is global state; leaving it set would leak into the next file.
  document.documentElement.dataset.theme = "dark";
});

describe("the theme setting", () => {
  it("starts dark, because that is the stored default", async () => {
    render(<App />);
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );
  });

  it("puts the light theme on <html> when it is chosen", async () => {
    const { container } = render(<App />);
    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("dark"),
    );

    // Both main views stay mounted, so the gear is in the tree twice; see
    // `src/test/appDom.ts`.
    await userEvent.click(libraryView(container).getByLabelText("Settings"));
    const group = await screen.findByRole("radiogroup", { name: "Theme" });
    await userEvent.click(
      await within(group).findByRole("radio", { name: "Light" }),
    );

    await waitFor(() =>
      expect(document.documentElement.dataset.theme).toBe("light"),
    );
  });

  it("resolves `system` against the platform rather than storing a palette", async () => {
    // `system` is not a third theme: what lands on `<html>` is one of the two
    // `tokens.css` defines, picked from `prefers-color-scheme`.
    const mql = {
      matches: true, // the platform is in light mode
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    const original = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => mql,
    });
    try {
      const { container } = render(<App />);
      await waitFor(() =>
        expect(libraryView(container).getByLabelText("Settings")).toBeTruthy(),
      );
      await userEvent.click(libraryView(container).getByLabelText("Settings"));
      const group = await screen.findByRole("radiogroup", { name: "Theme" });
      await userEvent.click(
        await within(group).findByRole("radio", { name: "System" }),
      );
      await waitFor(() =>
        expect(document.documentElement.dataset.theme).toBe("light"),
      );
      // And what is persisted is the preference, not the resolved palette —
      // otherwise a machine that switches later would be stuck on the value it
      // happened to have when the click landed.
      //
      // Waited for rather than read: the palette lands on `<html>` from state,
      // while the write is coalesced (`SAVE_COALESCE_MS`), so the two no longer
      // happen in the same tick.
      await waitFor(() => {
        const settings = fake
          .argsFor("plugin:store|set")
          .filter((w) => w.key === "settings")
          .map((w) => w.value as { theme?: string });
        expect(settings[settings.length - 1]?.theme).toBe("system");
      });
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: original,
      });
    }
  });
});
