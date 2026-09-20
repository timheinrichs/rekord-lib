/**
 * The playback settings, from the slider to the `<audio>` element.
 *
 * A flow test rather than a component test, because the value crosses four
 * pieces on the way and a mock would hide every seam: `SettingsView` only
 * reports the change, `App.tsx` merges and persists it through the store
 * plugin, `settings.ts` filters what comes back on the next load, and
 * `PlayerProvider` is the one that puts it on the element. A component test can
 * prove the slider calls back; it cannot prove the app got quieter, and it
 * cannot see a key dropped by `loadSettings` on the way home.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { libraryView } from "../test/appDom";
import { makeTrack } from "../test/factories";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";

const LIBRARY = "/fixture/library";

let fake: FakeBackend;

function seed(settings: Record<string, unknown>) {
  fake = installFakeBackend({
    files: [`${LIBRARY}/a.aiff`],
    tracks: [makeTrack({ path: `${LIBRARY}/a.aiff` })],
    store: { settings: { library_dir: LIBRARY, ...settings } },
  });
}

/** The provider's single hidden element — there is only ever one. */
function element(): HTMLAudioElement {
  const a = document.querySelector("audio");
  if (!a) throw new Error("no <audio> element");
  return a as HTMLAudioElement;
}

afterEach(() => {
  cleanup();
  fake.restore();
});

describe("the volume setting", () => {
  it("starts at the stored level, before anything is played", async () => {
    // The property survives a `src` change, so it does not wait for a track —
    // and must not, or the first track of a session would be loud.
    seed({ volume: 0.25 });
    render(<App />);
    await waitFor(() => expect(element().volume).toBe(0.25));
  });

  it("plays at full level when nothing is stored", async () => {
    seed({});
    render(<App />);
    await waitFor(() => expect(element().volume).toBe(1));
  });

  it("reaches the element as it is dragged", async () => {
    seed({ volume: 1 });
    const { container } = render(<App />);
    await waitFor(() => expect(element().volume).toBe(1));

    await userEvent.click(libraryView(container).getByLabelText("Settings"));
    // `fireEvent`: jsdom draws no track for a pointer to drag along.
    fireEvent.change(await screen.findByRole("slider", { name: "Volume" }), {
      target: { value: "0.4" },
    });

    await waitFor(() => expect(element().volume).toBe(0.4));
  });

  it("writes the file a couple of times for a whole drag, not once a step", async () => {
    // A `save()` rewrites all of `rekord-lib.json`, the Bandcamp collection
    // included. Before the write was coalesced, dragging this slider from one
    // end to the other produced a hundred rewrites — fired at the store without
    // being awaited against each other, so the level that ended up on disk was
    // whichever of the hundred happened to finish last.
    //
    // A range rather than an exact count, deliberately: the writes are paced
    // against the wall clock (`SAVE_COALESCE_MS`), so twenty renders on a busy
    // machine can legitimately span one more window than on an idle one. What
    // is being asserted is the order of magnitude, which is the thing that was
    // wrong.
    seed({ volume: 0 });
    const { container } = render(<App />);
    await waitFor(() => expect(element().volume).toBe(0));
    await userEvent.click(libraryView(container).getByLabelText("Settings"));
    const slider = await screen.findByRole("slider", { name: "Volume" });

    const before = fake.argsFor("plugin:store|save").length;
    for (let step = 1; step <= 20; step++) {
      fireEvent.change(slider, { target: { value: String(step / 20) } });
    }
    // Every step is on the element already: only the persisting waits.
    await waitFor(() => expect(element().volume).toBe(1));
    await waitFor(() => {
      const written = fake
        .argsFor("plugin:store|set")
        .filter((w) => w.key === "settings")
        .map((w) => w.value as { volume?: number });
      expect(written[written.length - 1]?.volume).toBe(1);
    });
    const saves = fake.argsFor("plugin:store|save").length - before;
    expect(saves).toBeGreaterThanOrEqual(1);
    expect(saves).toBeLessThanOrEqual(4);
  });

  it("survives a reload", async () => {
    // Through the real store handlers: the level is written as part of the
    // whole `settings` object and read back through `loadSettings`, which drops
    // any key it does not know. A key added to the interface and not to
    // `DEFAULT_SETTINGS` would be written here and gone on the way back — this
    // is the level that sees it.
    seed({ volume: 1 });
    const first = render(<App />);
    await waitFor(() => expect(element().volume).toBe(1));
    await userEvent.click(libraryView(first.container).getByLabelText("Settings"));
    fireEvent.change(await screen.findByRole("slider", { name: "Volume" }), {
      target: { value: "0.6" },
    });
    await waitFor(() => expect(element().volume).toBe(0.6));
    // The element follows the state; the file follows a beat later
    // (`SAVE_COALESCE_MS`). A reload before the write would be testing the
    // wrong thing.
    await waitFor(() => {
      const written = fake
        .argsFor("plugin:store|set")
        .filter((w) => w.key === "settings")
        .map((w) => w.value as { volume?: number });
      expect(written[written.length - 1]?.volume).toBe(0.6);
    });

    cleanup();
    render(<App />);
    await waitFor(() => expect(element().volume).toBe(0.6));
  });
});
