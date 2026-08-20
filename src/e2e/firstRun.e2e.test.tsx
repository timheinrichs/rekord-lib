/**
 * First run: an app with no library folder, through the settings, to rows on
 * screen.
 *
 * The flow worth pinning is not the one it looks like. A first population does
 * **not** go through the scan job: the incremental sync diffs the folder against
 * the database and hands every new file to `analyze_files`, one blocking command
 * with no progress events and no pause gate (`TODO.md`, C5a). A test written
 * against `start_scan` would pass while the real path was broken.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { libraryView } from "../test/appDom";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";

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
    expect(fake.called("analyze_files")).toBe(false);
  });

  it("populates the library through analyze_files, not through the scan job", async () => {
    const user = userEvent.setup();
    fake.state.dialogAnswer = LIBRARY;

    const { container } = render(<App />);
    await screen.findByText("No library folder selected");
    await user.click(
      libraryView(container).getByRole("button", { name: "Open settings" }),
    );
    await user.click(await screen.findByRole("button", { name: "Choose folder…" }));

    await waitFor(() => expect(fake.called("analyze_files")).toBe(true));

    // The arguments, in the casing Tauri actually renames them to. This is the
    // assertion the wrapper-mocking tests cannot make.
    const [args] = fake.argsFor("analyze_files");
    expect(args.paths).toEqual(FILES);
    expect(args.libraryDir).toBe(LIBRARY);
    // No tempo detection in the sync: the background job picks that up, so the
    // first fill stays as fast as it can be.
    expect(args.analyzeBpm).toBe(false);

    // The scan job does run, but only afterwards and only for the tempo: the
    // rows exist before it starts. That division is the whole reason the first
    // fill cannot be paused — `analyze_files` is one blocking call, and the
    // pausable job only gets the backlog.
    await waitFor(() => expect(fake.called("start_scan")).toBe(true));
    const [scan] = fake.argsFor("start_scan");
    expect(scan.dir).toBe(LIBRARY);
    expect(scan.analyzeBpm).toBe(true);
    // Scoped to the files just added, not a full sweep of the folder.
    expect(scan.paths).toEqual(FILES);
    // Neither force flag: the tag is the cache, and a backlog run must not
    // overwrite a tempo the collection already carries.
    expect(scan.forceBpm).toBe(false);
    expect(scan.force).toBe(false);
    // The configured tempo window reaches the detector. `analyze_files` is
    // called without it because it does no tempo detection at all.
    expect(scan.bpmMin).toBe(60);
    expect(scan.bpmMax).toBe(200);

    // The folder is remembered, so the next start does not ask again.
    await waitFor(() =>
      expect(
        (fake.state.store.settings as { library_dir?: string } | undefined)
          ?.library_dir,
      ).toBe(LIBRARY),
    );
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
    expect(fake.argsFor("analyze_files")[0]?.paths).toEqual(FILES);
    expect(libraryView(container).getByRole("banner")).toBeInTheDocument();
  });
});
