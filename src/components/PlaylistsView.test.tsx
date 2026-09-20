import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PlaylistsView from "./PlaylistsView";
import { makeMetadata, makeTrack } from "../test/factories";
import type { Playlists } from "../lib/usePlaylists";
import type { Playlist } from "../types";

/**
 * The playlists view, as a component: props in, `usePlaylists` calls out.
 *
 * Seven of `PlaylistEditor`'s eight assertions live here now — it was a preview
 * of this screen, opened from a group head, and the group head is gone. The
 * eighth was about closing a dialog, and there is no dialog.
 *
 * Two things are new and neither had a test before: a drag that reaches `move`
 * — the table's drag never had one — and switching playlists resetting an armed
 * delete, which is the whole reason the body is keyed by the playlist's id.
 */
const LIB = "/lib";

function playlist(id: number, name: string, track_count = 0): Playlist {
  return { id, name, created_ms: id, updated_ms: id, track_count };
}

function setup(over: Partial<Playlists> = {}) {
  const ops = {
    create: vi.fn(async () => 9),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    add: vi.fn(async () => {}),
    removeTracks: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    step: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    suggestName: (base: string) => base,
  };
  const playlists: Playlists = {
    all: [playlist(1, "Warmup", 2), playlist(2, "Peak", 0)],
    contents: { 1: [`${LIB}/a.aiff`, `${LIB}/b.aiff`], 2: [] },
    loaded: true,
    ...ops,
    ...over,
  };
  const tracks = [
    makeTrack({
      path: `${LIB}/a.aiff`,
      id: `${LIB}/a.aiff`,
      file_name: "a.aiff",
      metadata: makeMetadata({ title: "Alpha", artist: "One" }),
    }),
    makeTrack({
      path: `${LIB}/b.aiff`,
      id: `${LIB}/b.aiff`,
      file_name: "b.aiff",
      metadata: makeMetadata({ title: "Beta", artist: "Two" }),
    }),
  ];
  render(
    <PlaylistsView
      playlists={playlists}
      tracks={tracks}
      edits={{}}
      hiddenColumns={[]}
      active
    />,
  );
  return { user: userEvent.setup(), playlists, ...ops };
}

const rows = () =>
  within(
    screen.getByRole("rowgroup", { name: "Tracks in this playlist" }),
  ).getAllByRole("row");

/**
 * jsdom has no layout, so the rows are given one: 64 px tall, stacked from
 * zero. So row 0 spans 0–64 with its midpoint at 32, row 1 spans 64–128, and
 * anything past 128 is the end of the list.
 */
function withGeometry() {
  rows().forEach((r, i) => {
    r.getBoundingClientRect = () =>
      ({
        top: i * 64,
        height: 64,
        bottom: i * 64 + 64,
        left: 0,
        right: 0,
        width: 0,
      }) as DOMRect;
  });
}

beforeEach(() => {
  // jsdom implements no pointer capture. It is not optional in the component:
  // without it a drag stops the moment the pointer leaves the row it started
  // on, because the moves are then delivered to whatever is underneath.
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
});

/** Press on a row at `from`, travel to `to`, let go. */
function drag(row: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(row, { button: 0, clientY: from });
  fireEvent.pointerMove(row, { clientY: to });
  fireEvent.pointerUp(row, { clientY: to });
}

describe("PlaylistsView", () => {
  it("lists the playlists with their counts, and opens the first", () => {
    setup();
    const side = within(screen.getByRole("list", { name: "Playlists" }));
    expect(side.getByRole("button", { name: /Warmup/ })).toHaveTextContent("2");
    expect(side.getByRole("button", { name: /Peak/ })).toHaveTextContent("0");
    // Something is always open when there is anything to open.
    expect(screen.getByLabelText("Playlist name")).toHaveValue("Warmup");
  });

  it("shows the stored order, numbered", () => {
    setup();
    expect(rows().map((r) => r.textContent?.trim().charAt(0))).toEqual(["1", "2"]);
    expect(rows()[0]).toHaveTextContent("Alpha");
  });

  it("disables the moves that would go nowhere", () => {
    setup();
    expect(within(rows()[0]).getByLabelText(/up/)).toBeDisabled();
    expect(within(rows()[1]).getByLabelText(/down/)).toBeDisabled();
    expect(within(rows()[1]).getByLabelText(/up/)).toBeEnabled();
  });

  it("moves and removes through the one place playlist state lives", async () => {
    const { user, step, removeTracks } = setup();
    await user.click(within(rows()[1]).getByLabelText("Move “Beta” up"));
    expect(step).toHaveBeenCalledExactlyOnceWith(1, `${LIB}/b.aiff`, -1);

    await user.click(
      within(rows()[0]).getByLabelText("Remove “Alpha” from the playlist"),
    );
    expect(removeTracks).toHaveBeenCalledExactlyOnceWith(1, [`${LIB}/a.aiff`]);
  });

  it("renames on Enter and leaves the name alone on Escape", async () => {
    const { user, rename } = setup();
    const field = screen.getByLabelText("Playlist name");

    await user.clear(field);
    await user.type(field, "Peak time{Enter}");
    expect(rename).toHaveBeenCalledExactlyOnceWith(1, "Peak time");

    rename.mockClear();
    await user.clear(field);
    await user.type(field, "Nope{Escape}");
    expect(rename).not.toHaveBeenCalled();
    expect(field).toHaveValue("Warmup");
  });

  it("treats an emptied field as a cancelled edit", async () => {
    // `usePlaylists.rename` drops an empty name, so a field left blank has to
    // snap back rather than sit there showing something the playlist is not
    // called.
    const { user, rename } = setup();
    const field = screen.getByLabelText("Playlist name");
    await user.clear(field);
    await user.tab();
    expect(rename).not.toHaveBeenCalled();
    expect(field).toHaveValue("Warmup");
  });

  it("asks once before deleting, and says what it does not touch", async () => {
    const { user, remove } = setup();
    await user.click(screen.getByRole("button", { name: "Delete playlist" }));
    expect(remove).not.toHaveBeenCalled();

    const confirm = screen.getByRole("button", { name: /Delete “Warmup”/ });
    expect(confirm).toHaveTextContent("The files stay");
    await user.click(confirm);
    expect(remove).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("drops an armed delete when another playlist is opened", async () => {
    // Why the body is keyed by the playlist's id: a confirm that survived the
    // switch would be aimed at the wrong playlist, one click from landing.
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Delete playlist" }));
    expect(screen.getByRole("button", { name: /Delete “Warmup”/ })).toBeVisible();

    await user.click(
      within(screen.getByRole("list", { name: "Playlists" })).getByRole(
        "button",
        { name: /Peak/ },
      ),
    );
    expect(screen.getByRole("button", { name: "Delete playlist" })).toBeVisible();
  });

  it("reorders by pointer, onto a gap and onto the end of the list", async () => {
    // Pointer events, not HTML5 drag and drop: the window enables Tauri's own
    // file drop so the library can be filled by dragging files in, and that
    // takes drag and drop at the webview level — `dragstart` fires inside the
    // page and no `dragover` or `drop` ever arrives. The table's row drag was
    // dead from the day it shipped for exactly that reason.
    const { move } = setup();
    withGeometry();

    // Upper half of the first row: the gap above it.
    drag(rows()[1], 100, 10);
    expect(move).toHaveBeenCalledExactlyOnceWith(
      1,
      [`${LIB}/b.aiff`],
      `${LIB}/a.aiff`,
    );

    move.mockClear();
    withGeometry();
    // Past the last row: the end of the list, which `move` takes as `null`.
    drag(rows()[0], 10, 400);
    expect(move).toHaveBeenCalledExactlyOnceWith(1, [`${LIB}/a.aiff`], null);
  });

  it("does not move anything when the press never travelled", async () => {
    // A click on a row is not a drag. Without the threshold, pressing anywhere
    // and letting go would write the order back over itself.
    const { move } = setup();
    withGeometry();
    drag(rows()[1], 100, 102);
    expect(move).not.toHaveBeenCalled();
  });

  it("draws the line in the gap the move would use, and not before", async () => {
    // The indicator is the whole feedback: without it a drag is a guess about
    // where the row will land.
    setup();
    withGeometry();

    // Nothing is marked until the pointer has travelled.
    fireEvent.pointerDown(rows()[1], { button: 0, clientY: 100 });
    expect(rows()[1].className).not.toContain("accent-500");

    fireEvent.pointerMove(rows()[1], { clientY: 10 });
    expect(rows()[0].className).toContain("border-t-accent-500");

    fireEvent.pointerMove(rows()[1], { clientY: 400 });
    expect(rows()[1].className).toContain("border-b-accent-500");

    // A cancelled gesture leaves nothing painted and moves nothing.
    fireEvent.pointerCancel(rows()[1]);
    expect(rows()[1].className).not.toContain("accent-500");
  });

  it("marks no text while a row is being carried", async () => {
    // A pointer drawn across table cells selects their text, which painted
    // every row the drag passed over in the selection colour — the drag looked
    // like it was picking up everything it crossed.
    setup();
    withGeometry();
    const body = screen.getByRole("rowgroup", { name: "Tracks in this playlist" });
    expect(body.className).not.toContain("select-none");

    fireEvent.pointerDown(rows()[1], { button: 0, clientY: 100 });
    expect(body.className).toContain("select-none");

    // And it is selectable again afterwards, so a title can still be copied.
    fireEvent.pointerUp(rows()[1], { clientY: 100 });
    expect(body.className).not.toContain("select-none");
  });

  it("goes translucent while it is being carried", async () => {
    setup();
    withGeometry();
    expect(rows()[1].className).not.toContain("opacity-");

    fireEvent.pointerDown(rows()[1], { button: 0, clientY: 100 });
    expect(rows()[1].className).toContain("opacity-40");
    // Only the one being carried.
    expect(rows()[0].className).not.toContain("opacity-");
  });

  it("does not arm a drag from the row's own buttons", async () => {
    // Pressing ↑ must not start a gesture that then swallows the click.
    const { user, move, step } = setup();
    withGeometry();
    await user.click(within(rows()[1]).getByLabelText("Move “Beta” up"));
    expect(step).toHaveBeenCalledOnce();
    expect(move).not.toHaveBeenCalled();
  });

  it("says what an empty playlist is for", async () => {
    const { user } = setup();
    await user.click(
      within(screen.getByRole("list", { name: "Playlists" })).getByRole(
        "button",
        { name: /Peak/ },
      ),
    );
    expect(screen.getByText(/This playlist is empty/)).toBeInTheDocument();
  });

  it("opens on its only action when there are no playlists", async () => {
    const { user, create } = setup({ all: [], contents: {} });
    expect(screen.getByText("No playlists yet")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "New playlist" }));
    const field = screen.getByLabelText("New playlist name");
    await user.clear(field);
    await user.type(field, "Warm-up{Enter}");
    expect(create).toHaveBeenCalledExactlyOnceWith("Warm-up");
  });

  it("says nothing at all until the playlists have been read", () => {
    // "No playlists yet" over an unread database is a lie.
    setup({ all: [], contents: {}, loaded: false });
    expect(screen.queryByText("No playlists yet")).not.toBeInTheDocument();
  });
});
