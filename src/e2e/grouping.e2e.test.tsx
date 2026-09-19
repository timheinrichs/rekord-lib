/**
 * The well, in every grouping that has one.
 *
 * I1 is a visual rule, and a visual rule is exactly the kind that ships for one
 * grouping and is forgotten for the other three — the table folds rows five
 * different ways and each way renders its heads from its own branch. So this
 * drives the real app through all four and asks the same two questions of each:
 * does the open head say so in the accessibility tree, and are the rows it
 * contains in the well with it.
 *
 * The folder case carries a second claim, and it is the one that decides
 * against a fourth surface tone: nesting is unbounded, so **tone says whether a
 * row is contained and the indent says how deep**. Two open levels are the
 * same tone and a different indent, which is the rule stated as behaviour.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { libraryView } from "../test/appDom";
import { makeMetadata, makeTrack } from "../test/factories";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";

const LIBRARY = "/fixture/library";
const A = `${LIBRARY}/House/Deep/a.aiff`;
const B = `${LIBRARY}/House/Deep/b.aiff`;

let fake: FakeBackend;

beforeEach(() => {
  // One fixture serves all four: two tracks that share an album and a label,
  // two folders deep, and a playlist holding both.
  const track = (path: string, file: string, title: string) =>
    makeTrack({
      path,
      file_name: file,
      metadata: makeMetadata({
        title,
        album: "Deep Cuts",
        album_artist: "V/A",
        label: "Ostgut",
      }),
    });
  fake = installFakeBackend({
    files: [A, B],
    tracks: [track(A, "a.aiff", "Alpha"), track(B, "b.aiff", "Beta")],
    playlists: [{ id: 1, name: "Warmup", created_ms: 0, updated_ms: 0 }],
    playlistContents: { 1: [A, B] },
    store: { settings: { library_dir: LIBRARY } },
  });
});

afterEach(() => {
  cleanup();
  fake.restore();
});

async function ready(container: HTMLElement) {
  await waitFor(() =>
    expect(libraryView(container).getByTitle(A)).toBeInTheDocument(),
  );
  return libraryView(container);
}

/** The well tone, as the rule names it. */
const inWell = (row: HTMLElement) => row.className.includes("bg-bg");

/** Every data row, heads included — the header row has `th` cells. */
const bodyRows = () =>
  screen.getAllByRole("row").filter((r) => !r.querySelector("th"));

/** A head row; the well applies to heads and to what they contain alike. */
const isHead = (row: HTMLElement) => row.hasAttribute("aria-expanded");

describe("an expanded group, in every grouping", () => {
  it.each([
    ["Album", "Deep Cuts"],
    ["Label", "Ostgut"],
    ["Folder", "House"],
    ["Playlists", "Warmup"],
  ])("%s: opening a group puts it and its rows in the well", async (switchTo) => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    const view = await ready(container);

    await user.click(view.getByRole("button", { name: switchTo }));
    await waitFor(() => expect(bodyRows().some(isHead)).toBe(true));

    // Closed, nothing is contained, so nothing carries the tone.
    expect(bodyRows().some(inWell)).toBe(false);

    // Open every level. Label and Folder nest, so one click is not enough —
    // and a grouping that stopped nesting would still pass, which is the
    // point of driving it rather than asserting a count.
    for (let guard = 0; guard < 6; guard++) {
      const closed = screen.queryAllByRole("row", { expanded: false });
      if (!closed.length) break;
      await user.click(closed[0]);
    }

    const rows = bodyRows();
    expect(rows.filter(isHead).length).toBeGreaterThan(0);
    expect(rows.filter((r) => !isHead(r)).length).toBeGreaterThan(0);
    expect(rows.every(inWell)).toBe(true);
  });

  it("Label: a closed group inside an open one stays the raised lid", async () => {
    // The two tones doing different jobs in one column, which is what the
    // three-rung ladder buys: the well says *contained*, `surface-2/40` says
    // *there is more folded up in here*.
    const user = userEvent.setup();
    const { container } = render(<App />);
    const view = await ready(container);

    await user.click(view.getByRole("button", { name: "Label" }));
    await user.click((await screen.findAllByText("Ostgut"))[0]);

    const open = screen.getByRole("row", { expanded: true });
    const closed = screen.getByRole("row", { expanded: false });
    expect(inWell(open)).toBe(true);
    expect(inWell(closed)).toBe(false);
    expect(closed.className).toContain("bg-surface-2/40");
  });

  it("Folder: two open levels share a tone and differ by indent", async () => {
    // The argument against a fourth tone, as behaviour. Depth is unbounded and
    // the ladder has three rungs, so the tone cannot be the depth signal.
    const user = userEvent.setup();
    const { container } = render(<App />);
    const view = await ready(container);

    await user.click(view.getByRole("button", { name: "Folder" }));
    await user.click((await screen.findAllByText("House"))[0]);
    await user.click((await screen.findAllByText("Deep"))[0]);

    const open = screen.getAllByRole("row", { expanded: true });
    expect(open).toHaveLength(2);
    expect(open.every(inWell)).toBe(true);

    const indent = (row: HTMLElement) => {
      const padded = [...row.querySelectorAll<HTMLElement>("[style]")].find(
        (el) => el.style.paddingLeft,
      );
      return parseInt(padded?.style.paddingLeft ?? "0", 10);
    };
    expect(indent(open[1])).toBeGreaterThan(indent(open[0]));
  });

  it("Flat: a row that is in no group stays on the panel", async () => {
    // The well means *contained*. The default grouping has no containers, so
    // nothing in it may carry the tone.
    const { container } = render(<App />);
    await ready(container);

    expect(screen.queryAllByRole("row", { expanded: true })).toHaveLength(0);
    expect(bodyRows().some(inWell)).toBe(false);
  });
});
