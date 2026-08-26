import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PlaylistEditor from "./PlaylistEditor";
import type { PlaylistRow } from "../lib/playlists";

const playlist = {
  id: 1,
  name: "Warmup",
  created_ms: 1,
  updated_ms: 1,
  track_count: 2,
};

function row(over: Partial<PlaylistRow> & { position: number }): PlaylistRow {
  return {
    path: `/lib/${over.position}.aiff`,
    title: `Track ${over.position}`,
    artist: "Artist",
    outsideLibrary: false,
    ...over,
  };
}

function open(rows: PlaylistRow[] = [row({ position: 1 }), row({ position: 2 })]) {
  const props = {
    playlist,
    rows,
    onRename: vi.fn(),
    onStep: vi.fn(),
    onRemove: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
  };
  render(<PlaylistEditor {...props} />);
  return props;
}

describe("PlaylistEditor", () => {
  it("lists the playlist in its own order, numbered", () => {
    open([row({ position: 1, title: "First" }), row({ position: 2, title: "Second" })]);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("First");
    expect(items[0].textContent).toContain("1");
    expect(items[1].textContent).toContain("Second");
  });

  it("cannot move the first track up or the last one down", () => {
    // The ends of the list are where a step button would write the order it
    // already has, and a button that does nothing is worse than a disabled one.
    open();
    expect(screen.getByLabelText("Move “Track 1” up")).toBeDisabled();
    expect(screen.getByLabelText("Move “Track 1” down")).toBeEnabled();
    expect(screen.getByLabelText("Move “Track 2” down")).toBeDisabled();
  });

  it("steps a track, and removes one, by path", async () => {
    const user = userEvent.setup();
    const props = open();

    await user.click(screen.getByLabelText("Move “Track 2” up"));
    expect(props.onStep).toHaveBeenCalledWith("/lib/2.aiff", -1);

    await user.click(screen.getByLabelText("Remove “Track 1” from the playlist"));
    expect(props.onRemove).toHaveBeenCalledWith("/lib/1.aiff");
  });

  it("shows an entry the loaded library has no row for, and says where it is", async () => {
    // Not a deleted file — the schema cascades a membership away with its
    // track. This is a track in another library folder, so the row says that
    // rather than striking it through next to a remove button.
    const user = userEvent.setup();
    const props = open([
      row({
        position: 1,
        title: "vanished.aiff",
        artist: "",
        outsideLibrary: true,
      }),
    ]);

    expect(screen.getByText("In another library folder")).toBeInTheDocument();
    await user.click(
      screen.getByLabelText("Remove “vanished.aiff” from the playlist"),
    );
    expect(props.onRemove).toHaveBeenCalledWith("/lib/1.aiff");
  });

  it("renames on Enter and leaves the name alone on Escape", async () => {
    const user = userEvent.setup();
    const props = open();
    const name = screen.getByLabelText("Playlist name");

    await user.clear(name);
    await user.type(name, "Peak time{Enter}");
    expect(props.onRename).toHaveBeenCalledWith("Peak time");

    props.onRename.mockClear();
    await user.clear(name);
    await user.type(name, "Discarded{Escape}");
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("shows the stored name, not a rename that did not happen", async () => {
    // An empty name is a cancelled edit — `usePlaylists.rename` drops it — so
    // the field must not sit there empty while the playlist is still called
    // something, with the delete button below saying so.
    const user = userEvent.setup();
    const props = open();
    const name = screen.getByLabelText("Playlist name");

    await user.clear(name);
    await user.tab();

    expect(props.onRename).not.toHaveBeenCalled();
    expect(name).toHaveValue("Warmup");
  });

  it("asks before deleting the playlist, and says the files stay", async () => {
    const user = userEvent.setup();
    const props = open();

    await user.click(screen.getByRole("button", { name: "Delete playlist" }));
    expect(props.onDelete).not.toHaveBeenCalled();

    const confirm = screen.getByRole("button", { name: /The files stay/ });
    await user.click(confirm);
    expect(props.onDelete).toHaveBeenCalled();
    // And it gets out of the way, because what it was editing is gone.
    expect(props.onClose).toHaveBeenCalled();
  });

  it("says an empty playlist is empty, rather than showing nothing", () => {
    open([]);
    expect(screen.getByText(/This playlist is empty/)).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });
});
