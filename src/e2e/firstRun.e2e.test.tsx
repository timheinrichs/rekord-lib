/**
 * First run: an app with no library folder, through the settings, to rows on
 * screen.
 *
 * The flow worth pinning is the division of labour. The sync does the diff and
 * nothing else; every new file goes to the **scan job**, which is what gives the
 * first fill of a library counters and a pause gate. It did not always: it used
 * to hand them to `analyze_files`, one blocking call with no progress and no way
 * to stop it, which on ten thousand files was minutes of an unattributable
 * spinner (roadmap C5a, closed).
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { libraryView } from "../test/appDom";
import { makeTrack } from "../test/factories";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";
import { STAGE_ANALYZING } from "../types";

const LIBRARY = "/fixture/library";
const FILES = [
  `${LIBRARY}/Clicks/click-090.aiff`,
  `${LIBRARY}/Clicks/click-128.aiff`,
  `${LIBRARY}/Edge cases/no-tags.aiff`,
];

let fake: FakeBackend;

beforeEach(() => {
  // On disk but not in the database: exactly the state a first run is in.
  fake = installFakeBackend({ files: [...FILES], tracks: [] });
});

afterEach(() => {
  // Unmount first. The components unsubscribe on the way out, and their
  // `unlisten` goes through the mocked internals — clearing those first turns
  // every teardown into an unhandled rejection.
  cleanup();
  fake.restore();
});

describe("first run", () => {
  it("offers the settings when no library folder is set", async () => {
    const { container } = render(<App />);

    expect(
      await screen.findByText("No library folder selected"),
    ).toBeInTheDocument();
    expect(
      libraryView(container).getByRole("button", { name: "Open settings" }),
    ).toBeInTheDocument();

    // Nothing was asked of the library yet — there is no folder to ask about.
    expect(fake.called("list_audio_files")).toBe(false);
    expect(fake.called("start_scan")).toBe(false);
  });

  it("populates the library through the scan job, so the run can be watched and held", async () => {
    const user = userEvent.setup();
    fake.state.dialogAnswer = LIBRARY;

    const { container } = render(<App />);
    await screen.findByText("No library folder selected");
    await user.click(
      libraryView(container).getByRole("button", { name: "Open settings" }),
    );
    await user.click(await screen.findByRole("button", { name: "Choose folder…" }));

    await waitFor(() => expect(fake.called("start_scan")).toBe(true));

    // The arguments, in the casing Tauri actually renames them to. This is the
    // assertion the wrapper-mocking tests cannot make.
    const [scan] = fake.argsFor("start_scan");
    expect(scan.dir).toBe(LIBRARY);
    // Scoped to the files the diff found, not a full sweep: a sweep would
    // re-probe a library that is already known.
    expect(scan.paths).toEqual(FILES);
    // One run, one decode per file: the tempo comes along rather than being
    // fetched by a second pass over the same files.
    expect(scan.analyzeBpm).toBe(true);
    expect(scan.bpmMin).toBe(60);
    expect(scan.bpmMax).toBe(200);
    // Neither force flag: the tag is the cache, and a fill must not overwrite a
    // tempo the collection already carries.
    expect(scan.forceBpm).toBe(false);
    expect(scan.force).toBe(false);

    // And not the blocking command. That is the whole change: `analyze_files`
    // still exists for files dragged in from outside the library, but the fill
    // no longer goes through it.
    expect(fake.called("analyze_files")).toBe(false);

    // The folder is remembered, so the next start does not ask again.
    await waitFor(() =>
      expect(
        (fake.state.store.settings as { library_dir?: string } | undefined)
          ?.library_dir,
      ).toBe(LIBRARY),
    );
  });

it("keeps the splash up instead of showing an empty table", async () => {
    // What a first fill used to look like: the splash came down as soon as the
    // cache had been read, and the only sign of life for the minutes that
    // followed was one unlabelled spinner in the header, next to an empty table.
    // Held here at the folder listing, which is where the sync spends its time
    // before the scan takes over.
    const listed = fake.hold("list_audio_files");
    fake.state.store.settings = { library_dir: LIBRARY };

    render(<App />);

    // The splash says which part is running rather than dropping to nothing.
    expect(await screen.findByText("Loading library…")).toBeInTheDocument();
    expect(screen.queryByText("No library folder selected")).not.toBeInTheDocument();

    listed();

    // Once the scan reports, the splash counts instead of spinning.
    await waitFor(() => expect(fake.called("start_scan")).toBe(true));
    await fake.emit("scan://progress", {
      generation: 1,
      done: 1,
      total: 3,
      running: true,
      paused: false,
      stage: STAGE_ANALYZING,
    });
    expect(await screen.findByText("Analyzing 1/3")).toBeInTheDocument();
  });

  it("says what the header spinner is doing", async () => {
    // The indicator appears unprompted — a file dropped into the folder starts
    // it — so a bare spinner between two buttons belongs to neither of them as
    // far as a reader can tell.
    const listed = fake.hold("list_audio_files");
    fake.state.store.settings = { library_dir: LIBRARY };
    fake.state.tracks = [
      makeTrack({ path: FILES[0], file_name: "click-090.aiff" }),
    ];

    const { container } = render(<App />);

    await waitFor(() =>
      expect(libraryView(container).getByText("Updating library…")).toBeInTheDocument(),
    );

    listed();
  });

    it("survives a library database that failed to open, and says so", async () => {
    // `db::require` rejects when `Db::open` failed, and the backend tolerates
    // that on purpose — an empty library the next scan rebuilds beats refusing
    // to launch. The frontend has to hold the same line. Before this test
    // existed it did not: the boot chain was a `void (async …)` with no catch,
    // so the rejection went unhandled, `hydrated` was never set, persisting
    // stayed off and the tempo pass never started.
    fake.state.dbAvailable = false;
    fake.state.store.settings = { library_dir: LIBRARY };

    const { container } = render(<App />);

    await waitFor(() => expect(fake.called("library_load")).toBe(true));

    // Reported, not swallowed: an unreadable library that looks like an empty
    // one is the worse of the two failures.
    expect(
      await screen.findByText(/Could not read the library cache/),
    ).toBeInTheDocument();

    // And the boot carried on regardless — the folder is still swept, because
    // the files are on disk whatever the cache says.
    await waitFor(() => expect(fake.called("list_audio_files")).toBe(true));
    await waitFor(() =>
      expect(fake.argsFor("start_scan")[0]?.paths).toEqual(FILES),
    );
    expect(libraryView(container).getByRole("banner")).toBeInTheDocument();
  });
});
