/**
 * Writing tags and taking the write back.
 *
 * This is the flow where a wiring error is most expensive: undo is the one
 * operation whose whole promise is that the file ends up where it started. The
 * loop runs through the real wrappers here — edit, write, undo — so the snapshot
 * the backend takes and the entry the button names come from the same round trip
 * a user makes.
 *
 * Two limits worth stating rather than faking. Whether the restored bytes are
 * identical is a Rust question (`TODO.md`, C8: undo re-encodes the cover instead
 * of embedding the captured bytes), and so is `clear_empty`, which
 * `commands.rs` chooses per caller and never sends across the boundary.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { libraryView, overlay } from "../test/appDom";
import { makeMetadata, makeTrack } from "../test/factories";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";

const LIBRARY = "/fixture/library";
const TRACK = `${LIBRARY}/nocturne-01.aiff`;

let fake: FakeBackend;

beforeEach(() => {
  fake = installFakeBackend({
    files: [TRACK],
    tracks: [
      makeTrack({
        path: TRACK,
        file_name: "nocturne-01.aiff",
        metadata: makeMetadata({ title: "Nocturne", artist: "Artist" }),
      }),
    ],
    store: { settings: { library_dir: LIBRARY } },
  });
});

afterEach(() => {
  cleanup();
  fake.restore();
});

/** Edit the one row's title and confirm. */
async function rename(container: HTMLElement, to: string) {
  const user = userEvent.setup();
  const cell = await waitFor(() => libraryView(container).getByTitle(TRACK));
  const tr = cell.closest("tr");
  if (!tr) throw new Error("no row");
  await user.click(within(tr).getByRole("button", { name: "Edit metadata" }));
  await screen.findByRole("button", { name: /confirm/i });
  const title = overlay().getByLabelText(/^Title\*?$/);
  await user.clear(title);
  await user.type(title, to);
  await user.click(screen.getByRole("button", { name: /confirm/i }));
  return user;
}

describe("undo", () => {
  it("offers to take back the write, named after what it would undo", async () => {
    const { container } = render(<App />);
    await rename(container, "Renamed");

    await waitFor(() => expect(fake.called("write_metadata")).toBe(true));

    // The button names the entry, so a user can tell what would come back.
    // `undo_peek` is what supplies that, and it is asked after the write rather
    // than guessed from it.
    await waitFor(() => expect(fake.called("undo_peek")).toBe(true));
    expect(
      await screen.findByTitle("Undo the last tag write (nocturne-01.aiff)"),
    ).toBeInTheDocument();
  });

  it("restores the previous tags and stops offering", async () => {
    const { container } = render(<App />);
    const user = await rename(container, "Renamed");

    const undo = await screen.findByTitle(
      "Undo the last tag write (nocturne-01.aiff)",
    );
    await user.click(undo);

    await waitFor(() => expect(fake.called("undo_last")).toBe(true));

    // The snapshot the backend took was the state *before* the write, so this
    // is the original title, not the one just typed.
    await waitFor(() =>
      expect(fake.state.tracks[0].metadata.title).toBe("Nocturne"),
    );

    // And with nothing left to take back, the button goes away rather than
    // offering an undo that would do nothing.
    await waitFor(() =>
      expect(
        libraryView(container).queryByTitle(
          "Undo the last tag write (nocturne-01.aiff)",
        ),
      ).not.toBeInTheDocument(),
    );
  });

  it("does not offer an undo before anything has been written", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(fake.called("undo_peek")).toBe(true));

    expect(
      libraryView(container).queryByRole("button", { name: "Undo" }),
    ).not.toBeInTheDocument();
  });

  it("reports a failed undo instead of pretending it worked", async () => {
    const { container } = render(<App />);
    const user = await rename(container, "Renamed");
    const undo = await screen.findByTitle(
      "Undo the last tag write (nocturne-01.aiff)",
    );

    // `undo_last` returns `AppResult`, so unlike the write it *can* reject.
    fake.fail("undo_last", "the library database is unavailable");
    await user.click(undo);

    expect(await screen.findByText(/Failed to undo/)).toBeInTheDocument();
    // The entry is still there, because nothing was taken back.
    expect(
      libraryView(container).getByTitle(
        "Undo the last tag write (nocturne-01.aiff)",
      ),
    ).toBeInTheDocument();
  });
});
