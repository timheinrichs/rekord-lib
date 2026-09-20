/**
 * An action that changed something says so — and the many things that must not.
 *
 * The rule this pins is the one that is easy to state and easy to lose: a
 * transient message is an event log row on its way past, never a second
 * reporting channel. So the only way one can appear is for the backend to have
 * written it, and the only thing that decides whether it appears is the flag
 * the backend put on it. Both halves are checked here against the real `App`,
 * because neither is visible to a component test — the subscription, the
 * filter, the portal and the log all live in different files.
 *
 * `src/test/fakeBackend.ts` records the way the real backend does, into the log
 * *and* onto the wire. Before I7 no fake command emitted `events://new` at all,
 * so none of this had anywhere to be seen.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { libraryView, overlay } from "../test/appDom";
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
    playlists: [{ id: 1, name: "Warmup", created_ms: 1, updated_ms: 1 }],
    playlistContents: {},
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

/** The app's only app-level announcer, found by name rather than by role. */
const messages = () =>
  within(screen.getByRole("status", { name: "Notifications" }));

describe("an action that changed something says so", () => {
  it("says what was added, in the backend's own words", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    const view = await ready(container);

    await user.click(view.getAllByRole("checkbox")[0]);
    await user.click(screen.getByRole("button", { name: /Add to playlist/ }));
    await user.click(await overlay().findByRole("button", { name: /Warmup/ }));

    // The sentence is written once, in Rust, and travels with the log row —
    // the frontend composes nothing, which is what stops the two from ever
    // disagreeing about what happened.
    expect(
      await messages().findByText("Added 2 tracks to Warmup"),
    ).toBeInTheDocument();
  });

  it("leaves the same sentence in the log", async () => {
    // The other half of "one channel": what was shown is also what was kept.
    const user = userEvent.setup();
    const { container } = render(<App />);
    const view = await ready(container);

    await user.click(view.getAllByRole("checkbox")[0]);
    await user.click(screen.getByRole("button", { name: /Add to playlist/ }));
    await user.click(await overlay().findByRole("button", { name: /Warmup/ }));
    await messages().findByText("Added 2 tracks to Warmup");

    await user.click(view.getByRole("button", { name: "Event log" }));
    expect(
      await screen.findAllByText("Added 2 tracks to Warmup"),
    ).toHaveLength(2);
  });

  it("stays quiet for what a scan collects per file", async () => {
    // The wall this feature has to not be. Two files on disk that the analysis
    // cannot read fill the log and light the badge, and draw nothing: the flag
    // that decides it is set where a scan is known to be a scan.
    //
    // Files rather than rows, because that is what a scan looks at — a track
    // already in the database with a matching mtime is never re-probed.
    const C = `${LIBRARY}/c.aiff`;
    const D = `${LIBRARY}/d.aiff`;
    fake.state.files = [...fake.state.files, C, D];
    fake.state.skipped = { [C]: "no audio stream", [D]: "no audio stream" };

    const { container } = render(<App />);
    await ready(container);

    await waitFor(() =>
      expect(fake.state.events.length).toBeGreaterThanOrEqual(2),
    );
    expect(fake.state.events.every((e) => e.level === "warn")).toBe(true);
    expect(messages().queryByText(/Skipped/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "Notifications" }),
    ).toBeEmptyDOMElement();
  });

  it("raises nothing at boot, however full the log already is", async () => {
    // Reading the log does not emit, so the five hundred rows a long-running
    // library has collected cannot arrive as five hundred messages. This is
    // structural rather than a rule someone has to remember, and this is where
    // that claim is checked.
    fake.state.events = [
      {
        id: 9,
        created_ms: 1,
        level: "info",
        source: "export",
        message: "Exported 2 tracks for Rekordbox",
        detail: null,
      },
    ];
    const { container } = render(<App />);
    await ready(container);

    expect(
      screen.getByRole("status", { name: "Notifications" }),
    ).toBeEmptyDOMElement();
  });

  it("shows a notice the backend marked, and only that one", async () => {
    // Straight at the boundary, because the two cases differ by one field and
    // nothing else — a filter written on `level` or on `source` would pass one
    // of these and fail the other.
    const { container } = render(<App />);
    await ready(container);

    await fake.emit("events://new", {
      id: 101,
      level: "warn",
      message: "Skipped c.aiff: no audio stream",
      announce: false,
    });
    await fake.emit("events://new", {
      id: 102,
      level: "warn",
      message: "Moved 1 of 2 tracks to the trash",
      announce: true,
    });

    expect(
      await messages().findByText("Moved 1 of 2 tracks to the trash"),
    ).toBeInTheDocument();
    expect(messages().queryByText(/Skipped/)).not.toBeInTheDocument();
  });
});
