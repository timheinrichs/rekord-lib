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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { libraryView } from "../test/appDom";
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
    await user.click(screen.getByRole("button", { name: "New playlist…" }));
    const field = screen.getByLabelText("New playlist name");
    await user.clear(field);
    await user.type(field, "Warmup{Enter}");

    await waitFor(() => expect(fake.called("playlist_create")).toBe(true));
    expect(fake.argsFor("playlist_create")[0].name).toBe("Warmup");

    // The contents arrive as one ordered list — the order is the payload.
    await waitFor(() => expect(fake.called("playlist_set")).toBe(true));
    const [set] = fake.argsFor("playlist_set");
    expect(set.paths).toEqual([A, B]);
  });

  it("will not offer a playlist the selection is already in", async () => {
    // Adding tracks to the playlist they are already in is a click that does
    // nothing, and the menu should say so rather than let it happen.
    const user = userEvent.setup();
    fake.state.playlists = [
      { id: 1, name: "Has both", created_ms: 1, updated_ms: 1 },
      { id: 2, name: "Has one", created_ms: 2, updated_ms: 2 },
    ];
    fake.state.playlistContents = { 1: [A, B], 2: [A] };

    const { container } = render(<App />);
    await selectAll(user, container);
    await user.click(screen.getByRole("button", { name: /Add to playlist/ }));

    expect(screen.getByRole("button", { name: /Has both/ })).toBeDisabled();
    // The other one says what it would actually take.
    const partial = screen.getByRole("button", { name: /Has one/ });
    expect(partial).toBeEnabled();
    expect(partial.textContent).toContain("+1 of 2");
  });

  it("shows the playlist as a group, with a position per row", async () => {
    const user = userEvent.setup();
    fake.state.playlists = [
      { id: 1, name: "Warmup", created_ms: 1, updated_ms: 1 },
    ];
    // Deliberately not the table's order: a playlist shows its own.
    fake.state.playlistContents = { 1: [B, A] };

    const { container } = render(<App />);
    const view = await ready(container);

    await user.click(view.getByRole("button", { name: "Playlists" }));
    // `getAllByText`: MarqueeText renders a hidden measuring copy next to the
    // real one, so every name in this table matches twice.
    await waitFor(() => expect(view.getAllByText("Warmup").length).toBeGreaterThan(0));

    // Everything not in a playlist has somewhere to be, even when empty.
    expect(view.getAllByText(/Unsorted/).length).toBeGreaterThan(0);

    // Groups open on click, like every other grouping in this table.
    await user.click(view.getAllByText("Warmup")[0]);

    const rows = view.getAllByRole("row");
    const beta = rows.find((r) => within(r).queryByTitle(B));
    expect(beta).toBeTruthy();
    // First in the playlist, whatever the table would have sorted it as.
    expect(beta!.textContent).toContain("1");
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
    // And it says what it did, with a number.
    expect(await view.findByText(/Exported 2 tracks and 1 playlist/)).toBeInTheDocument();
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

  it("renames a playlist and reads the result back", async () => {
    const user = userEvent.setup();
    fake.state.playlists = [{ id: 1, name: "Frist", created_ms: 1, updated_ms: 1 }];
    fake.state.playlistContents = { 1: [A] };

    const { container } = render(<App />);
    const view = await ready(container);
    await user.click(view.getByRole("button", { name: "Playlists" }));

    await user.click(await view.findByRole("button", { name: "Playlist actions" }));
    await user.click(screen.getByRole("button", { name: "Rename" }));
    const field = screen.getByLabelText("Playlist name");
    await user.clear(field);
    await user.type(field, "First{Enter}");

    await waitFor(() => expect(fake.called("playlist_rename")).toBe(true));
    expect(fake.argsFor("playlist_rename")[0]).toEqual({ id: 1, name: "First" });
    // Re-read, not assumed: the head shows what the backend now holds.
    await waitFor(() => expect(view.getAllByText("First").length).toBeGreaterThan(0));
  });

  it("deletes a playlist only after asking, and keeps the tracks", async () => {
    const user = userEvent.setup();
    fake.state.playlists = [{ id: 1, name: "Gone", created_ms: 1, updated_ms: 1 }];
    fake.state.playlistContents = { 1: [A] };

    const { container } = render(<App />);
    const view = await ready(container);
    await user.click(view.getByRole("button", { name: "Playlists" }));

    await user.click(await view.findByRole("button", { name: "Playlist actions" }));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    // One click is not enough — the second names what is about to go.
    expect(fake.called("playlist_delete")).toBe(false);
    await user.click(screen.getByRole("button", { name: /Delete “Gone”/ }));

    await waitFor(() => expect(fake.called("playlist_delete")).toBe(true));
    // Nothing was deleted from disk, and the track is still in the library —
    // seen from Flat, because the group it used to sit in is gone.
    expect(fake.called("delete_files")).toBe(false);
    await user.click(view.getByRole("button", { name: "Flat" }));
    await waitFor(() => expect(view.getByTitle(A)).toBeInTheDocument());
  });
});
