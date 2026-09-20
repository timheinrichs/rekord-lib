import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PlaylistsView from "./PlaylistsView";
import { PlayerProvider } from "../lib/player";
import { makeMetadata, makeTrack } from "../test/factories";
import type { Playlists } from "../lib/usePlaylists";
import type { Playlist, TrackAnalysis } from "../types";

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

function setup(over: Partial<Playlists> = {}, library?: TrackAnalysis[]) {
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
  const tracks = library ?? [
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
  // The real provider rather than a mock: the view queues the playlist it is
  // showing, and a stub would not be able to disagree with it.
  render(
    <PlayerProvider>
      <PlaylistsView
        playlists={playlists}
        tracks={tracks}
        edits={{}}
        hiddenColumns={[]}
        active
      />
    </PlayerProvider>,
  );
  return { user: userEvent.setup(), playlists, ...ops };
}

/** Four tracks in a playlist, which is what a multi-row drag needs. */
function setupFour() {
  const paths = [1, 2, 3, 4].map((n) => `${LIB}/${n}.aiff`);
  return setup(
    { all: [playlist(1, "Set", 4)], contents: { 1: paths } },
    paths.map((p, i) =>
      makeTrack({
        path: p,
        id: p,
        file_name: `${i + 1}.aiff`,
        metadata: makeMetadata({ title: `T${i + 1}`, artist: "A" }),
      }),
    ),
  );
}

const rows = () =>
  within(
    screen.getByRole("rowgroup", { name: "Tracks in this playlist" }),
  ).getAllByRole("row");

/**
 * jsdom has no layout, so the rows are given one that **follows the DOM**: each
 * row is 64 px tall and sits at its current index, computed when it is asked.
 *
 * Live rather than a snapshot, because the list reorders under the pointer —
 * a fixed set of boxes would answer for an order that no longer exists, which
 * is the one thing a drag across several rows depends on getting right.
 */
function withLiveGeometry() {
  const at = (r: HTMLElement) =>
    [...(r.parentElement?.children ?? [])].indexOf(r) * 64;
  rows().forEach((r) => {
    r.getBoundingClientRect = () =>
      ({
        top: at(r),
        height: 64,
        bottom: at(r) + 64,
        left: 0,
        right: 0,
        width: 0,
      }) as DOMRect;
    Object.defineProperty(r, "offsetTop", {
      get: () => at(r),
      configurable: true,
    });
  });
}

/**
 * The same, but frozen at the order it was called in — enough for the tests
 * that never reorder.
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

/** The handle a row is picked up by. */
const handle = (row: HTMLElement) => within(row).getByLabelText(/^Reorder/);

/** Press the row's handle at `from`, travel to `to`, let go. */
function drag(row: HTMLElement, from: number, to: number) {
  fireEvent.pointerDown(handle(row), { button: 0, clientY: from });
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

  it("reorders from the keyboard, and not past the ends", () => {
    // The handle is a button so a long playlist can be reordered without a
    // pointer at all: a drag gesture has no keyboard equivalent, and HTML5
    // drag would have had no auto-scroll even if it worked here.
    const { step } = setup();

    fireEvent.keyDown(handle(rows()[1]), { key: "ArrowUp" });
    expect(step).toHaveBeenCalledExactlyOnceWith(1, `${LIB}/b.aiff`, -1);

    step.mockClear();
    fireEvent.keyDown(handle(rows()[0]), { key: "ArrowUp" });
    fireEvent.keyDown(handle(rows()[1]), { key: "ArrowDown" });
    expect(step).not.toHaveBeenCalled();
  });

  it("removes through the one place playlist state lives", async () => {
    const { user, removeTracks } = setup();
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

  it("moves the row itself as the pointer travels, and writes what is shown", () => {
    // The whole interaction, and the reason there is no indicator to draw: the
    // list reorders under the pointer, so what is dropped is what was already
    // on screen. The rows are numbered by their place, so the numbers follow.
    const { move } = setup();
    withGeometry();
    const titles = () => rows().map((r) => within(r).getAllByText(/Alpha|Beta/)[0].textContent);

    expect(titles()).toEqual(["Alpha", "Beta"]);

    fireEvent.pointerDown(handle(rows()[1]), { button: 0, clientY: 100 });
    // Into the upper half of the first row: Beta is already above Alpha.
    fireEvent.pointerMove(rows()[1], { clientY: 10 });
    expect(titles()).toEqual(["Beta", "Alpha"]);
    expect(rows()[0].textContent?.trim().startsWith("1")).toBe(true);
    // Nothing is written until it is let go.
    expect(move).not.toHaveBeenCalled();

    fireEvent.pointerUp(rows()[1], { clientY: 10 });
    // Expressed against the stored list: Beta goes before Alpha.
    expect(move).toHaveBeenCalledExactlyOnceWith(
      1,
      [`${LIB}/b.aiff`],
      `${LIB}/a.aiff`,
    );
  });

  it("carries a row to the end of the list", () => {
    // The gap a drop target *on* a row could never express, which is why the
    // pointer's position rather than a row is what decides.
    const { move } = setup();
    withGeometry();
    drag(rows()[0], 10, 400);
    expect(move).toHaveBeenCalledExactlyOnceWith(1, [`${LIB}/a.aiff`], null);
  });

  it("puts the row back when the gesture is cancelled", () => {
    // The preview is only a preview: an abandoned drag must leave the stored
    // order alone and stop showing its own idea of it.
    const { move } = setup();
    withGeometry();
    fireEvent.pointerDown(handle(rows()[1]), { button: 0, clientY: 100 });
    fireEvent.pointerMove(rows()[1], { clientY: 10 });
    expect(rows()[0]).toHaveTextContent("Beta");

    fireEvent.pointerCancel(rows()[1]);
    expect(rows()[0]).toHaveTextContent("Alpha");
    expect(move).not.toHaveBeenCalled();
  });

  it("does not move anything when the press never travelled", () => {
    // A click on the handle is not a drag. Without the threshold, pressing and
    // letting go would write the order back over itself.
    const { move } = setup();
    withGeometry();
    drag(rows()[1], 100, 102);
    expect(move).not.toHaveBeenCalled();
  });

  it("carries a copy of the row under the pointer", () => {
    // Two things at once, both wanted: the list reorders below, and the row
    // itself follows the pointer. Without the copy the row just teleports.
    setup();
    withGeometry();
    fireEvent.pointerDown(handle(rows()[1]), { button: 0, clientY: 100 });
    // Not before the press has travelled: a click must not flash a card.
    expect(screen.getAllByText("Beta")).toHaveLength(1);

    fireEvent.pointerMove(rows()[1], { clientY: 10 });
    expect(screen.getAllByText("Beta")).toHaveLength(2);

    fireEvent.pointerUp(rows()[1], { clientY: 10 });
    expect(screen.getAllByText("Beta")).toHaveLength(1);
  });

  it("does not arm a drag from the row's other buttons", async () => {
    // Only the handle picks a row up; pressing − must not start a gesture that
    // then swallows the click.
    const { user, move, removeTracks } = setup();
    withGeometry();
    await user.click(
      within(rows()[1]).getByLabelText("Remove “Beta” from the playlist"),
    );
    expect(removeTracks).toHaveBeenCalledOnce();
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

  it("carries a row down past more than one neighbour", () => {
    // One row down worked and two did not, which is the case a snapshot of the
    // geometry cannot show: after the first swap the pointer is inside the
    // carried row, and the next gap is decided by rows that have all moved.
    const { move, playlists } = setupFour();
    withLiveGeometry();
    const titles = () =>
      rows().map((r) => within(r).getAllByText(/T[1-4]/)[0].textContent);

    expect(titles()).toEqual(["T1", "T2", "T3", "T4"]);

    fireEvent.pointerDown(handle(rows()[0]), { button: 0, clientY: 32 });
    // Past T2's midpoint: one down.
    fireEvent.pointerMove(rows()[0], { clientY: 100 });
    expect(titles()).toEqual(["T2", "T1", "T3", "T4"]);

    // Past T3's midpoint, which is now at 160: two down.
    fireEvent.pointerMove(rows()[1], { clientY: 170 });
    expect(titles()).toEqual(["T2", "T3", "T1", "T4"]);

    // And a third, to the end.
    fireEvent.pointerMove(rows()[2], { clientY: 240 });
    expect(titles()).toEqual(["T2", "T3", "T4", "T1"]);

    fireEvent.pointerUp(rows()[3], { clientY: 240 });
    expect(move).toHaveBeenCalledExactlyOnceWith(1, [`${LIB}/1.aiff`], null);
    expect(playlists.contents[1]).toBeDefined();
  });

  it("carries a row up past more than one neighbour", () => {
    const { move } = setupFour();
    withLiveGeometry();
    const titles = () =>
      rows().map((r) => within(r).getAllByText(/T[1-4]/)[0].textContent);

    fireEvent.pointerDown(handle(rows()[3]), { button: 0, clientY: 224 });
    fireEvent.pointerMove(rows()[3], { clientY: 150 });
    expect(titles()).toEqual(["T1", "T2", "T4", "T3"]);

    fireEvent.pointerMove(rows()[2], { clientY: 80 });
    expect(titles()).toEqual(["T1", "T4", "T2", "T3"]);

    fireEvent.pointerMove(rows()[1], { clientY: 10 });
    expect(titles()).toEqual(["T4", "T1", "T2", "T3"]);

    fireEvent.pointerUp(rows()[0], { clientY: 10 });
    expect(move).toHaveBeenCalledExactlyOnceWith(
      1,
      [`${LIB}/4.aiff`],
      `${LIB}/1.aiff`,
    );
  });
});
