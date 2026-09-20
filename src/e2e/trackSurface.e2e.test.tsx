/**
 * The track surface, from the two things that open it to the command it asks
 * for once it is up.
 *
 * A flow test, because everything interesting here spans pieces a mock would
 * hide: which view is on screen is a `className` in `App.tsx`, the detail
 * waveform is an argument name on an `invoke`, and "closing the player closes
 * the surface" is an effect in one component reading a context provided by
 * another. A component test of `TrackView` can prove it renders; it cannot
 * prove the app ever gets there, and it cannot see `resolution` misspelled.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { forgetAllDetail } from "../lib/detailWaveforms";
import { isShown, libraryView, trackView } from "../test/appDom";
import { makeMetadata, makeTrack } from "../test/factories";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";

const LIBRARY = "/fixture/library";
const A = `${LIBRARY}/a.aiff`;
const B = `${LIBRARY}/b.aiff`;

let fake: FakeBackend;

beforeEach(() => {
  // The detail waveforms are cached at module scope, as the row waveforms and
  // the covers are, so one test's decode would answer the next one's request
  // and the call it is asserting would never be made.
  forgetAllDetail();
  fake = installFakeBackend({
    files: [A, B],
    tracks: [
      makeTrack({
        path: A,
        file_name: "a.aiff",
        metadata: makeMetadata({ bpm: 128 }),
        beat_offset_secs: 0.25,
      }),
      makeTrack({ path: B, file_name: "b.aiff" }),
    ],
    waveforms: [A, B],
    store: { settings: { library_dir: LIBRARY } },
  });
});

afterEach(() => {
  cleanup();
  fake.restore();
});

/** Opens the surface the way a user does: through a row. */
async function openFromRow(container: HTMLElement) {
  const rows = await waitFor(() =>
    libraryView(container).getAllByLabelText("Open this track"),
  );
  await userEvent.click(rows[0]);
  return waitFor(() => trackView(container));
}

describe("the track surface", () => {
  it("opens from a row, and the views it replaces go away", async () => {
    const { container } = render(<App />);
    await openFromRow(container);

    expect(isShown(container, "library")).toBe(false);
    expect(isShown(container, "playlists")).toBe(false);
    expect(isShown(container, "bandcamp")).toBe(false);
    // And it is the row's own track, not whatever was playing before: `a.aiff`
    // is the only one with a stored grid, and the surface says so.
    expect(trackView(container).getByText("0.250 s")).toBeInTheDocument();
  });

  it("opens the track and nothing else", async () => {
    // The button sits inside a row whose own click opens the metadata editor.
    // Without a stopped propagation the click does both, and the dialog mounts
    // inside a view that is now hidden — to appear unasked on the way back.
    const { container } = render(<App />);
    await openFromRow(container);
    // The editor's confirm button is the thing that is only ever on screen when
    // the editor is. Counting overlays would count the boot splash too.
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });

  it("asks for a detail waveform, by that name", async () => {
    // The one assertion no component test can make: `detailWaveform` writes
    // `resolution: "detail"`, and a rename on either side of the boundary is
    // invisible to everything that mocks `lib/api`.
    const { container } = render(<App />);
    await openFromRow(container);

    await waitFor(() =>
      expect(
        fake.argsFor("waveform").some((a) => a.resolution === "detail"),
      ).toBe(true),
    );
    const detail = fake.argsFor("waveform").find((a) => a.resolution === "detail");
    expect(detail?.path).toBe(A);
  });

  it("opens and closes from the player bar", async () => {
    const { container } = render(<App />);
    await openFromRow(container);

    // The bar lives outside the app shell, so it is not inside any view.
    const expand = () =>
      container.ownerDocument.body.querySelector<HTMLButtonElement>(
        '[aria-label="Back to the library"], [aria-label="Open this track"][aria-pressed]',
      );
    await userEvent.click(expand()!);
    await waitFor(() => expect(isShown(container, "library")).toBe(true));

    await userEvent.click(expand()!);
    await waitFor(() => trackView(container));
  });

  it("goes away with the player it belongs to", async () => {
    // The surface is always the track the player is on, so there is no state
    // saying which — and closing the player has to close it rather than leave a
    // heading over a blank.
    const { container } = render(<App />);
    await openFromRow(container);

    await userEvent.click(
      container.ownerDocument.body.querySelector<HTMLButtonElement>(
        '[aria-label="Close player"]',
      )!,
    );
    await waitFor(() => expect(isShown(container, "library")).toBe(true));
  });

  it("keeps the stored overview when the closer look cannot be had", async () => {
    // The stored overview answers from the scan's cache; only the decode fails.
    // A file that is busy for a moment is not a file with no waveform, so the
    // lane keeps the coarse picture and says which one it is showing.
    fake.fail("waveform", "no audio decoded");
    const { container } = render(<App />);
    await openFromRow(container);

    await waitFor(() =>
      expect(
        trackView(container).getByText(/the closer look is unavailable/i),
      ).toBeInTheDocument(),
    );
  });

  it("says so rather than claiming a picture it does not have", async () => {
    // Nothing stored and nothing decodable: the lane is blank, and a caption
    // about an overview would be describing an empty rectangle.
    fake.state.waveforms = [];
    fake.fail("waveform", "no audio decoded");
    const { container } = render(<App />);
    await openFromRow(container);

    await waitFor(() =>
      expect(
        trackView(container).getByText(/could not be read for a waveform/i),
      ).toBeInTheDocument(),
    );
  });
});
