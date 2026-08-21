/**
 * The scan, from the button to the rows filling in.
 *
 * This is the flow with the most timing in it, and the timing is deliberate:
 * results arrive one per finished file, but reach the table on a 250 ms window
 * (`lib/scanPatchBatch.ts`) because the list has no memoised rows. A test that
 * asserts a value right after the event would be asserting the wrong contract —
 * so the window itself is pinned here, in both directions.
 *
 * Two other things this flow is the only place to check: pause is not cancel,
 * and a file the analysis could not use has to become visible rather than
 * silently missing.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import App from "../App";
import { libraryView } from "../test/appDom";
import { makeMetadata, makeTrack } from "../test/factories";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";
import { STAGE_BPM_KEY } from "../types";

const LIBRARY = "/fixture/library";
const CLICK_090 = `${LIBRARY}/click-090.aiff`;
const CLICK_128 = `${LIBRARY}/click-128.aiff`;

let fake: FakeBackend;

// Distinct titles, because the name column shows `metadata.title || file_name`
// and the shared factory gives every track the same one.
function seededTracks() {
  return [
    makeTrack({
      path: CLICK_090,
      file_name: "click-090.aiff",
      metadata: makeMetadata({ title: "Click 090" }),
    }),
    makeTrack({
      path: CLICK_128,
      file_name: "click-128.aiff",
      metadata: makeMetadata({ title: "Click 128" }),
    }),
  ];
}

/**
 * The row for a track, so an assertion cannot pass on a neighbour's cell.
 *
 * Found by the path, which the name cell carries as its `title` and which is
 * unique per row. The visible text is not usable as an anchor: `MarqueeText`
 * renders a hidden measuring copy alongside the real one, so every name matches
 * twice.
 */
function row(container: HTMLElement, path: string) {
  const cell = libraryView(container).getByTitle(path);
  const found = cell.closest("tr");
  if (!found) throw new Error(`no row around ${path}`);
  return within(found);
}

beforeEach(() => {
  fake = installFakeBackend({
    files: [CLICK_090, CLICK_128],
    tracks: seededTracks(),
    store: { settings: { library_dir: LIBRARY, analyze_bpm: true } },
  });
});

afterEach(() => {
  cleanup();
  fake.restore();
});

async function renderWithLibrary() {
  const rendered = render(<App />);
  await waitFor(() =>
    expect(
      libraryView(rendered.container).getByTitle(CLICK_090),
    ).toBeInTheDocument(),
  );
  return rendered;
}

describe("the scan", () => {
  it("sweeps the whole folder rather than a list of paths", async () => {
    const user = userEvent.setup();
    const { container } = await renderWithLibrary();

    // The start-up backlog run goes first and is scoped to paths; the button is
    // the deliberate full sweep. Distinguishing the two is the point.
    const before = fake.argsFor("start_scan").length;
    await user.click(
      libraryView(container).getByRole("button", { name: /Scan library/ }),
    );

    await waitFor(() =>
      expect(fake.argsFor("start_scan").length).toBe(before + 1),
    );
    const args = fake.argsFor("start_scan")[before];
    expect(args.dir).toBe(LIBRARY);
    expect(args.paths).toBeNull();
    expect(args.analyzeBpm).toBe(true);
    // Not the deep re-probe: `force` is reachable through the command and no
    // view sets it.
    expect(args.force).toBe(false);
  });

  it("holds a patch for the batching window, then applies it", async () => {
    const { container } = await renderWithLibrary();

    // No tempo yet — the seeded track has none.
    expect(row(container, CLICK_128).queryByText("128")).not.toBeInTheDocument();

    await fake.emit("scan://patch", {
      generation: 1,
      patch: {
        path: CLICK_128,
        bpm: 128,
        bpm_confidence: 0.9,
        key: null,
        key_camelot: null,
        key_confidence: null,
        waveform: false,
      },
    });

    // Still not there: the collector is holding it. If this ever starts
    // failing, either the window went away or a row stopped being batched —
    // both worth knowing, because the batching is what keeps a large library
    // from re-rendering twenty times a second.
    expect(row(container, CLICK_128).queryByText("128")).not.toBeInTheDocument();

    // And within the window it arrives.
    await waitFor(
      () => expect(row(container, CLICK_128).getByText("128")).toBeInTheDocument(),
      { timeout: 2000 },
    );

    // Only that row. A patch names one path and must not touch its neighbours.
    expect(row(container, CLICK_090).queryByText("90")).not.toBeInTheDocument();
  });

  it("treats a null field in a patch as unchanged, not as cleared", async () => {
    const { container } = await renderWithLibrary();

    await fake.emit("scan://patch", {
      generation: 1,
      patch: {
        path: CLICK_090,
        bpm: 90,
        bpm_confidence: 0.8,
        key: null,
        key_camelot: null,
        key_confidence: null,
        waveform: false,
      },
    });
    await waitFor(() =>
      expect(row(container, CLICK_090).getByText("90")).toBeInTheDocument(),
    );

    // A second result that found only the key. The tempo must survive it.
    await fake.emit("scan://patch", {
      generation: 1,
      patch: {
        path: CLICK_090,
        bpm: null,
        bpm_confidence: null,
        key: "A minor",
        key_camelot: "8A",
        key_confidence: 0.7,
        waveform: false,
      },
    });
    await waitFor(() =>
      // Key and camelot share one cell, as `formatKey` joins them.
      expect(
        row(container, CLICK_090).getByText("A minor · 8A"),
      ).toBeInTheDocument(),
    );
    expect(row(container, CLICK_090).getByText("90")).toBeInTheDocument();
  });

  it("pauses and resumes without cancelling", async () => {
    const user = userEvent.setup();
    const { container } = await renderWithLibrary();

    await fake.emit("scan://progress", {
      generation: 1,
      done: 1,
      total: 2,
      running: true,
      paused: false,
      stage: STAGE_BPM_KEY,
    });

    // The counters reach the button, in the shape `boot.ts` derives.
    const button = await waitFor(() =>
      libraryView(container).getByRole("button", { name: /BPM\/Key 1\/2/ }),
    );

    await user.click(button);
    await waitFor(() => expect(fake.called("set_scan_paused")).toBe(true));
    expect(fake.argsFor("set_scan_paused")[0].paused).toBe(true);
    // Pause is not cancel. The command exists and nothing may reach for it here.
    expect(fake.called("cancel_scan")).toBe(false);

    // Paused keeps the counters in view, because they say where it continues.
    await fake.emit("scan://progress", {
      generation: 1,
      done: 1,
      total: 2,
      running: true,
      paused: true,
      stage: STAGE_BPM_KEY,
    });
    const paused = await waitFor(() =>
      libraryView(container).getByRole("button", { name: /Paused · BPM\/Key 1\/2/ }),
    );

    await user.click(paused);
    await waitFor(() =>
      expect(fake.argsFor("set_scan_paused")[1].paused).toBe(false),
    );
    expect(fake.called("cancel_scan")).toBe(false);
  });

  it("only re-reads the thumbnail of a file it really re-probed", async () => {
    // A scan batch carries both: rows the analysis produced and rows it reused
    // from the database unchanged. Only the first kind can have new artwork, and
    // treating them alike would re-decode a thumbnail for every visible row on
    // every scan — a flicker, and work for nothing.
    class Intersecting {
      constructor(private cb: IntersectionObserverCallback) {}
      observe() {
        this.cb(
          [{ isIntersecting: true } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    }
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    vi.stubGlobal("IntersectionObserver", Intersecting);

    render(<App />);
    await waitFor(() => expect(fake.called("cover_thumbnail")).toBe(true));
    const before = fake.argsFor("cover_thumbnail").length;

    // Both tracks come back in one batch; only the first was re-probed.
    await fake.emit("scan://tracks", {
      generation: 1,
      tracks: seededTracks(),
      fresh: [CLICK_090],
    });

    await waitFor(() =>
      expect(fake.argsFor("cover_thumbnail").length).toBeGreaterThan(before),
    );
    const asked = fake
      .argsFor("cover_thumbnail")
      .slice(before)
      .map((a) => a.path);
    expect(asked).toContain(CLICK_090);
    expect(asked).not.toContain(CLICK_128);
  });

  it("makes a skipped file visible instead of quietly missing", async () => {
    const { container } = await renderWithLibrary();

    expect(
      libraryView(container).queryByText(/file[s]? skipped/),
    ).not.toBeInTheDocument();

    await fake.emit("scan://skipped", {
      path: `${LIBRARY}/broken.aiff`,
      file_name: "broken.aiff",
      reason: "ffprobe exit 1: Invalid data found when processing input",
    });

    expect(
      await screen.findByText("1 file skipped"),
    ).toBeInTheDocument();

    // The same file met again with the same reason does not count twice.
    await fake.emit("scan://skipped", {
      path: `${LIBRARY}/broken.aiff`,
      file_name: "broken.aiff",
      reason: "ffprobe exit 1: Invalid data found when processing input",
    });
    expect(await screen.findByText("1 file skipped")).toBeInTheDocument();
  });
});
