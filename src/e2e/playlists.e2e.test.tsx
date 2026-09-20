/**
 * Playlists, from an empty library view to an order that survives a reload.
 *
 * The flow worth pinning is the division of labour. Ordering is decided in
 * `lib/playlists.ts`, which is pure and tested on its own; the database stores
 * whatever list it is handed. What neither of those can show is the wiring
 * between them — that "Add to playlist" reaches `playlist_set` with the paths
 * the user selected, in the order the table was showing them, and that the view
 * reads the result back rather than believing its own optimistic copy.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { libraryView, overlay, playlistsView } from "../test/appDom";
import { makeMetadata, makeTrack } from "../test/factories";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";

const LIBRARY = "/fixture/library";
const A = `${LIBRARY}/a.aiff`;
const B = `${LIBRARY}/b.aiff`;

let fake: FakeBackend;

beforeEach(() => {
  fake = installFakeBackend({
    files: [A, B],
    tracks: [
      makeTrack({
        path: A,
        file_name: "a.aiff",
        metadata: makeMetadata({ title: "Alpha" }),
      }),
      makeTrack({
        path: B,
        file_name: "b.aiff",
        metadata: makeMetadata({ title: "Beta" }),
      }),
    ],
    store: { settings: { library_dir: LIBRARY } },
  });
});

afterEach(() => {
  cleanup();
  fake.restore();
});

/**
 * The open playlist's rows. Scoped to the list that holds them, because the
 * sidebar beside it is a list of playlists and would otherwise be counted in.
 */
async function trackRows(container: HTMLElement) {
  const view = playlistsView(container);
  const list = await view.findByRole("list", { name: "Tracks in this playlist" });
  return within(list).getAllByRole("listitem");
}

/**
 * The library view, once the splash is gone and the rows are in. Every test
 * here starts with it: `libraryView` throws while the app is still booting, and
 * that error reads like a broken selector rather than a race.
 */
async function ready(container: HTMLElement) {
  await waitFor(() =>
    expect(libraryView(container).getByTitle(A)).toBeInTheDocument(),
  );
  return libraryView(container);
}

/** Selects every row, the way the header checkbox does. */
async function selectAll(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
) {
  const view = await ready(container);
  await user.click(view.getAllByRole("checkbox")[0]);
}

describe("playlists", () => {
  it("puts a selection into a new playlist, in the order on screen", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    await selectAll(user, container);

    await user.click(screen.getByRole("button", { name: /Add to playlist/ }));

    // With no playlists yet the dialog opens on its only action, so there is
    // no "New playlist…" to press first — the picker has nothing to pick from.
    const field = overlay().getByLabelText("New playlist name");
    await user.clear(field);
    await user.type(field, "Warmup{Enter}");

    await waitFor(() => expect(fake.called("playlist_create")).toBe(true));
    expect(fake.argsFor("playlist_create")[0].name).toBe("Warmup");

    // The contents arrive as one ordered list — the order is the payload.
    await waitFor(() => expect(fake.called("playlist_set")).toBe(true));
    const [set] = fake.argsFor("playlist_set");
    expect(set.paths).toEqual([A, B]);

    // A dialog that committed has to leave; the menu closed itself by losing
    // focus, and this one has to be told to.
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("will not offer a playlist the selection is already in", async () => {
    // Adding tracks to the playlist they are already in is a click that does
    // nothing, and the dialog should say so rather than let it happen.
    const user = userEvent.setup();
    fake.state.playlists = [
      { id: 1, name: "Has both", created_ms: 1, updated_ms: 1 },
      { id: 2, name: "Has one", created_ms: 2, updated_ms: 2 },
    ];
    fake.state.playlistContents = { 1: [A, B], 2: [A] };

    const { container } = render(<App />);
    await selectAll(user, container);
    await user.click(screen.getByRole("button", { name: /Add to playlist/ }));

    expect(overlay().getByRole("button", { name: /Has both/ })).toBeDisabled();
    // The other one says what it would actually take.
    const partial = overlay().getByRole("button", { name: /Has one/ });
    expect(partial).toBeEnabled();
    expect(partial.textContent).toContain("+1 of 2");
  });

  it("shows a playlist in its own order, with a position per row", async () => {
    const user = userEvent.setup();
    fake.state.playlists = [
      { id: 1, name: "Warmup", created_ms: 1, updated_ms: 1 },
    ];
    // Deliberately not the library's order: a playlist shows its own.
    fake.state.playlistContents = { 1: [B, A] };

    const { container } = render(<App />);
    const library = await ready(container);

    await user.click(library.getByRole("button", { name: "Playlists" }));

    // The first playlist opens by itself: "playlists exist but none is picked"
    // is a state with nothing to say, so it never reaches the screen.
    const rows = await trackRows(container);
    const beta = rows.find((r) => within(r).queryByTitle(B));
    expect(beta).toBeTruthy();
    // First in the playlist, whatever the library would have sorted it as.
    expect(beta!.textContent).toContain("1");
  });

  it("edits a playlist in the dialog, and writes the order it shows", async () => {
    // What has to hold is the wiring: the whole stored playlist is on screen —
    // the table could only ever show what the filter left over, which is why
    // this used to need a dialog — and a step writes the new order through
    // `playlist_set`.
    const user = userEvent.setup();
    fake.state.playlists = [
      { id: 1, name: "Warmup", created_ms: 1, updated_ms: 1 },
    ];
    fake.state.playlistContents = { 1: [A, B] };

    const { container } = render(<App />);
    const library = await ready(container);

    await user.click(library.getByRole("button", { name: "Playlists" }));
    const view = playlistsView(container);

    expect(await view.findByLabelText("Playlist name")).toHaveValue("Warmup");
    expect(await trackRows(container)).toHaveLength(2);

    await user.click(view.getByLabelText("Move “Beta” up"));

    await waitFor(() => expect(fake.called("playlist_set")).toBe(true));
    const [set] = fake.argsFor("playlist_set");
    expect(set).toEqual({ id: 1, paths: [B, A] });
  });

  it("takes a track out of the playlist, but not off the disk", async () => {
    // Two destructive buttons a few pixels apart would tell "remove from this
    // playlist" from "move the file to the trash" by their icon alone. The
    // playlists view offers the first one only; deleting a file is what the
    // library is for, and the separation is now a matter of which screen you
    // are on rather than of which row.
    const user = userEvent.setup();
    fake.state.playlists = [
      { id: 1, name: "Warmup", created_ms: 1, updated_ms: 1 },
    ];
    fake.state.playlistContents = { 1: [A] };

    const { container } = render(<App />);
    const library = await ready(container);

    await user.click(library.getByRole("button", { name: "Playlists" }));

    const row = (await trackRows(container))[0];
    expect(within(row).queryByLabelText("Delete track")).toBeNull();

    // And the one that is there does what it says: the playlist changes, the
    // file is not touched.
    await user.click(within(row).getByLabelText(/^Remove/));
    await waitFor(() => expect(fake.called("playlist_set")).toBe(true));
    expect(fake.called("delete_files")).toBe(false);
  });

  it("keeps a track in two playlists, each with its own place", async () => {
    // Membership is many-to-many and the position belongs to the pair, not to
    // the track. This used to be one screen showing the same track twice, which
    // made it a React key hazard as well — one flat array of rows fed one
    // tbody, and keyed by the track alone the two rows reconciled into one. A
    // view shows one playlist at a time, so that half cannot happen any more
    // and the claim underneath it is checked directly.
    const user = userEvent.setup();
    fake.state.playlists = [
      { id: 1, name: "Warmup", created_ms: 1, updated_ms: 1 },
      { id: 2, name: "Peak", created_ms: 2, updated_ms: 2 },
    ];
    fake.state.playlistContents = { 1: [A], 2: [B, A] };

    const { container } = render(<App />);
    const library = await ready(container);
    await user.click(library.getByRole("button", { name: "Playlists" }));
    const view = playlistsView(container);

    const placeOfA = async () => {
      const rows = await trackRows(container);
      const row = rows.find((r) => within(r).queryByTitle(A));
      expect(row).toBeTruthy();
      return row!.textContent?.trim().charAt(0);
    };

    await user.click(
      await view.findByRole("button", { name: /Warmup/ }),
    );
    expect(await placeOfA()).toBe("1");

    await user.click(view.getByRole("button", { name: /Peak/ }));
    expect(await placeOfA()).toBe("2");
  });

  it("exports the library where the save dialog points", async () => {
    // The one file the app writes outside the library folder, so the path has
    // to come from the user and the count from the backend that wrote it.
    const user = userEvent.setup();
    fake.state.playlists = [{ id: 1, name: "Warmup", created_ms: 1, updated_ms: 1 }];
    fake.state.playlistContents = { 1: [A] };
    fake.state.dialogAnswer = "/Users/me/Desktop/rekordbox.xml";

    const { container } = render(<App />);
    const view = await ready(container);
    await user.click(view.getByRole("button", { name: /Export for Rekordbox/ }));

    await waitFor(() => expect(fake.called("export_rekordbox_xml")).toBe(true));
    expect(fake.argsFor("export_rekordbox_xml")[0]).toEqual({
      dir: LIBRARY,
      dest: "/Users/me/Desktop/rekordbox.xml",
    });
    // What it did is said in the event log, which the backend writes — this
    // level can only show that the button stops claiming to be busy.
    await waitFor(() =>
      expect(
        view.getByRole("button", { name: /Export for Rekordbox/ }),
      ).toBeEnabled(),
    );
  });

  it("writes nothing when the save dialog is cancelled", async () => {
    const user = userEvent.setup();
    fake.state.dialogAnswer = null;

    const { container } = render(<App />);
    const view = await ready(container);
    await user.click(view.getByRole("button", { name: /Export for Rekordbox/ }));

    await waitFor(() => expect(fake.called("plugin:dialog|save")).toBe(true));
    expect(fake.called("export_rekordbox_xml")).toBe(false);
  });

  it("puts a row back where the database has it when a write fails", async () => {
    // The optimistic order is shown before the write returns. If the write does
    // not land, the only honest thing left is what the database says — and it
    // has to arrive as a row moving back, not as an unhandled rejection in a
    // console nobody has open.
    const user = userEvent.setup();
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    fake.state.playlists = [{ id: 1, name: "Set", created_ms: 1, updated_ms: 1 }];
    fake.state.playlistContents = { 1: [A, B] };
    fake.fail("playlist_set", "database is locked");

    const { container } = render(<App />);
    const library = await ready(container);
    await user.click(library.getByRole("button", { name: "Playlists" }));

    // The first row, moved down: the write fails, so the order must come back.
    const first = (await trackRows(container))[0];
    await user.click(within(first).getByLabelText(/^Move .* down/));

    await waitFor(() => expect(fake.called("playlist_set")).toBe(true));
    // Re-read, and the order is the one that was there all along.
    await waitFor(async () => {
      const rows = await trackRows(container);
      const row = rows.find((r) => within(r).queryByTitle(A));
      expect(row?.textContent?.trim().charAt(0)).toBe("1");
    });
    expect(unhandled).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandled);
  });

  it("renames a playlist and reads the result back", async () => {
    const user = userEvent.setup();
    fake.state.playlists = [{ id: 1, name: "Frist", created_ms: 1, updated_ms: 1 }];
    fake.state.playlistContents = { 1: [A] };

    const { container } = render(<App />);
    const library = await ready(container);
    await user.click(library.getByRole("button", { name: "Playlists" }));
    const view = playlistsView(container);

    const field = await view.findByLabelText("Playlist name");
    await user.clear(field);
    await user.type(field, "First{Enter}");

    await waitFor(() => expect(fake.called("playlist_rename")).toBe(true));
    expect(fake.argsFor("playlist_rename")[0]).toEqual({ id: 1, name: "First" });
    // Re-read, not assumed: the sidebar shows what the backend now holds.
    await waitFor(() =>
      expect(view.getByRole("button", { name: /First/ })).toBeInTheDocument(),
    );
  });

  it("deletes a playlist only after asking, and keeps the tracks", async () => {
    const user = userEvent.setup();
    fake.state.playlists = [{ id: 1, name: "Gone", created_ms: 1, updated_ms: 1 }];
    fake.state.playlistContents = { 1: [A] };

    const { container } = render(<App />);
    const library = await ready(container);
    await user.click(library.getByRole("button", { name: "Playlists" }));
    const view = playlistsView(container);

    await user.click(await view.findByRole("button", { name: "Delete playlist" }));
    // One click is not enough — the second names what is about to go.
    expect(fake.called("playlist_delete")).toBe(false);
    await user.click(view.getByRole("button", { name: /Delete “Gone”/ }));

    await waitFor(() => expect(fake.called("playlist_delete")).toBe(true));
    // Nothing was deleted from disk, and the track is still in the library —
    // asked of the library itself, which is where a track lives whether or not
    // any playlist does.
    expect(fake.called("delete_files")).toBe(false);
    await user.click(view.getByRole("button", { name: "Library" }));
    await waitFor(() =>
      expect(libraryView(container).getByTitle(A)).toBeInTheDocument(),
    );
  });
});
