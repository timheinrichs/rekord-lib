/**
 * Bandcamp: connect, list the collection, download into the library.
 *
 * Not one of the five flows the roadmap item named. It is here because it is
 * the chain that carries the most untrusted input — a purchase page's titles
 * and a downloaded archive both come from outside — and because
 * `bandcamp_download` is the third command in the app that reports failure
 * inside a successful return (`success: false`), which is the shape a view is
 * most likely to read as "done".
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { bandcampView, isShown, libraryView } from "../test/appDom";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";
import type { BandcampItem } from "../types";

const LIBRARY = "/fixture/library";

const PURCHASE: BandcampItem = {
  key: "item-1",
  title: "Nocturne EP",
  band_name: "Someone",
  item_type: "album",
  art_url: null,
  download_page_url: "https://bandcamp.example/download/item-1",
};

let fake: FakeBackend;

beforeEach(() => {
  fake = installFakeBackend({
    files: [],
    tracks: [],
    account: { username: "someone", fan_id: 42 },
    collection: [PURCHASE],
    store: {
      settings: { library_dir: LIBRARY, download_format: "flac" },
    },
  });
});

afterEach(() => {
  cleanup();
  fake.restore();
});

async function openBandcamp() {
  const user = userEvent.setup();
  const rendered = render(<App />);
  await waitFor(() => expect(fake.called("bandcamp_status")).toBe(true));
  // Each view renders its own header, so the nav exists twice. Click the one
  // in the view that is actually on screen.
  await user.click(
    libraryView(rendered.container).getByRole("button", { name: "Bandcamp" }),
  );
  await waitFor(() => expect(isShown(rendered.container, "bandcamp")).toBe(true));
  return { user, ...rendered };
}

describe("bandcamp", () => {
  it("asks for the connected account before anything else", async () => {
    render(<App />);
    // The status is read at start-up, not when the view is opened: the header
    // has to know whether there is an account before a user goes looking.
    await waitFor(() => expect(fake.called("bandcamp_status")).toBe(true));
  });

  it("shows the purchases it was given", async () => {
    const { container } = await openBandcamp();

    await waitFor(() => expect(fake.called("bandcamp_collection")).toBe(true));
    expect(
      await waitFor(() => bandcampView(container).getByTitle("Nocturne EP")),
    ).toBeInTheDocument();
  });

  it("downloads into the library folder, in the configured format", async () => {
    const { user, container } = await openBandcamp();
    await waitFor(() => bandcampView(container).getByTitle("Nocturne EP"));

    await user.click(
      // Exactly "Download": the two header actions ("Download all", "Download
      // missing") would match a looser name, and they do something else.
      bandcampView(container).getByRole("button", { name: "Download" }),
    );

    await waitFor(() => expect(fake.called("bandcamp_download")).toBe(true));
    const [args] = fake.argsFor("bandcamp_download");
    expect(args.key).toBe("item-1");
    // The page URL is passed through as given rather than rebuilt from the key.
    expect(args.pageUrl).toBe(PURCHASE.download_page_url);
    // Into the library folder, so a download lands where the scan will find it.
    expect(args.destDir).toBe(LIBRARY);
    // The configured format, mapped to Bandcamp's own key.
    expect(args.format).toBe("flac");
  });

  it("reports a failed download instead of recording it as present", async () => {
    // `bandcamp_download` returns `Ok` with `success: false` — the same trap as
    // the conversion and the tag write. Recording a failed download in the
    // ledger would make the sync treat the purchase as already downloaded and
    // never fetch it again.
    fake.failItem("item-1", "429 Too Many Requests");

    const { user, container } = await openBandcamp();
    await waitFor(() => bandcampView(container).getByTitle("Nocturne EP"));
    await user.click(
      // Exactly "Download": the two header actions ("Download all", "Download
      // missing") would match a looser name, and they do something else.
      bandcampView(container).getByRole("button", { name: "Download" }),
    );

    await waitFor(() => expect(fake.called("bandcamp_download")).toBe(true));
    // Nothing written to the ledger, which is what the sync reads.
    await waitFor(() =>
      expect(fake.state.store.bandcamp_downloads ?? {}).toEqual({}),
    );
  });

  it("streams progress while a download runs", async () => {
    const finish = fake.hold("bandcamp_download");
    const { user, container } = await openBandcamp();
    await waitFor(() => bandcampView(container).getByTitle("Nocturne EP"));
    await user.click(
      // Exactly "Download": the two header actions ("Download all", "Download
      // missing") would match a looser name, and they do something else.
      bandcampView(container).getByRole("button", { name: "Download" }),
    );
    await waitFor(() => expect(fake.called("bandcamp_download")).toBe(true));

    await fake.emit("bandcamp://progress", {
      key: "item-1",
      downloaded: 5_000_000,
      total: 10_000_000,
      stage: "Downloading",
    });

    // While it runs, the item's own button carries the state — and stops
    // offering a second download of the same purchase.
    const busy = await waitFor(() =>
      bandcampView(container).getByRole("button", { name: "Loading…" }),
    );
    expect(busy).toBeDisabled();
    expect(
      bandcampView(container).queryByRole("button", { name: "Download" }),
    ).not.toBeInTheDocument();

    finish();
    await waitFor(() =>
      expect(fake.state.store.bandcamp_downloads).toBeDefined(),
    );
  });
});
