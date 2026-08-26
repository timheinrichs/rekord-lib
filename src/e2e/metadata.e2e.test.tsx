/**
 * Editing a track's tags, from the row's pencil to the write.
 *
 * The shape worth pinning is that a save is two things at once. `saveEdit`
 * records the edit — so it survives a quit while the tags are not yet on disk —
 * *and* writes it, in that order. A test that only watched `write_metadata`
 * would pass with the persistence gone, and a pending edit would then be lost
 * on every failed write.
 *
 * `metadata::write::finalize` and its `clear_empty` flag are not reachable from
 * here: the flag is chosen in `commands.rs` per caller and never crosses the
 * boundary. That belongs to the Rust tests and to the wdio suite; `docs/METADATA.md`
 * describes it.
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
import { libraryView, overlay } from "../test/appDom";
import { makeMetadata, makeTrack } from "../test/factories";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";
import type { WriteMetadataItem } from "../lib/api";

const LIBRARY = "/fixture/library";
const TRACK = `${LIBRARY}/no-tags.aiff`;

let fake: FakeBackend;

beforeEach(() => {
  fake = installFakeBackend({
    files: [TRACK],
    tracks: [
      makeTrack({
        path: TRACK,
        file_name: "no-tags.aiff",
        metadata: makeMetadata({ title: "Before", artist: "Artist" }),
        metadata_incomplete: true,
      }),
    ],
    store: { settings: { library_dir: LIBRARY } },
    discogs: { kind: "app", key: "key-123", secret: "secret-456" },
  });
});

afterEach(() => {
  cleanup();
  fake.restore();
});

/** Open the editor for the one seeded row. */
async function openEditor(container: HTMLElement) {
  const user = userEvent.setup();
  const cell = await waitFor(() => libraryView(container).getByTitle(TRACK));
  const tr = cell.closest("tr");
  if (!tr) throw new Error("no row");
  await user.click(
    within(tr).getByRole("button", { name: "Edit metadata" }),
  );
  await screen.findByRole("button", { name: /confirm/i });
  return user;
}

/**
 * The input for a field. Each one is wrapped in its own `<label>`, so the
 * accessible name is the way in — and it has to tolerate the trailing `*`,
 * which is how a required field marks itself.
 */
function field(label: string): HTMLElement {
  return overlay().getByLabelText(new RegExp(`^${label}\\*?$`));
}

describe("editing metadata", () => {
  it("asks for suggestions without carrying the Discogs secret", async () => {
    const { container } = render(<App />);
    await openEditor(container);

    await waitFor(() => expect(fake.called("suggest_metadata")).toBe(true));
    const [args] = fake.argsFor("suggest_metadata");
    expect(args.path).toBe(TRACK);
    // The credentials are in the Keychain and the backend reads them there.
    // A secret that travels on every suggestion request is a secret the
    // frontend holds — this is the test that fails if it comes back.
    expect(args).toEqual({ path: TRACK });
  });

  it("suggests without a credential, because Discogs allows it", async () => {
    // The app searches Discogs anonymously when nothing is stored — a token
    // only raises the rate limit. Before this, no credential meant no chips,
    // and every new user had to register a Discogs application first.
    fake.restore();
    fake = installFakeBackend({
      files: [TRACK],
      tracks: [
        makeTrack({
          path: TRACK,
          file_name: "no-tags.aiff",
          metadata: makeMetadata({ title: "Before", artist: "Artist" }),
          metadata_incomplete: true,
        }),
      ],
      store: { settings: { library_dir: LIBRARY } },
      discogs: null,
    });
    const { container } = render(<App />);
    await openEditor(container);

    // Not just that the command was called — the chip has to be on screen,
    // which is what a user without a Discogs account gets out of this.
    expect(
      await overlay().findByRole("button", { name: "Deep House" }),
    ).toBeInTheDocument();
  });

  it("records the edit and writes it, in that order", async () => {
    const { container } = render(<App />);
    const user = await openEditor(container);

    await user.clear(field("Title"));
    await user.type(field("Title"), "After");
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(fake.called("write_metadata")).toBe(true));

    // Recorded, because the tags are not on disk yet and a quit must not lose
    // the intent.
    expect(fake.called("edit_set")).toBe(true);
    expect(fake.argsFor("edit_set")[0].path).toBe(TRACK);

    // And written, carrying the typed value.
    const [args] = fake.argsFor("write_metadata");
    const items = args.items as WriteMetadataItem[];
    expect(items).toHaveLength(1);
    expect(items[0].path).toBe(TRACK);
    expect(items[0].metadata.title).toBe("After");

    // Undo is recorded by default, and labelled with something a button can
    // name back to the user.
    expect(args.recordUndo).toBe(true);
    expect(args.label).toBe("no-tags.aiff");
  });

  it("re-reads the thumbnail of a file it wrote", async () => {
    // The row is re-analyzed after a write, but the thumbnail comes from its own
    // cache. Without the invalidation the old artwork stays on screen until the
    // app restarts, and a correct write looks like one that did nothing (C7).
    //
    // The shared setup's IntersectionObserver never intersects, so covers stay
    // unloaded unless a test drives them — this one has to, because the load is
    // the thing being counted.
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
    // Cleanup in a hook, not at the end of the body: a failing assertion above
    // would otherwise leak an always-intersecting observer into the tests after
    // it, which are written against the shared stub that never intersects.
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    vi.stubGlobal("IntersectionObserver", Intersecting);

    const { container } = render(<App />);
    await waitFor(() => expect(fake.called("cover_thumbnail")).toBe(true));
    const before = fake.argsFor("cover_thumbnail").length;

    const user = await openEditor(container);
    await user.clear(field("Title"));
    await user.type(field("Title"), "After");
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(fake.called("write_metadata")).toBe(true));
    await waitFor(() =>
      expect(fake.argsFor("cover_thumbnail").length).toBeGreaterThan(before),
    );
    const asked = fake.argsFor("cover_thumbnail");
    expect(asked[asked.length - 1]).toEqual({ path: TRACK });
  });

  it("reports a per-file write failure without claiming success", async () => {
    // `write_metadata` never rejects either: the failure is an `error` on the
    // item, inside a successful return.
    fake.failItem(TRACK, "lofty: unsupported tag for this container");

    const { container } = render(<App />);
    const user = await openEditor(container);
    await user.clear(field("Title"));
    await user.type(field("Title"), "After");
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    expect(
      await screen.findByText(/unsupported tag for this container/),
    ).toBeInTheDocument();

    // The row shows the new title even though the write failed — the edit is
    // applied optimistically, on purpose. What must not happen is that it looks
    // *written*: the pending-tags button is the standing signal that the value
    // on screen is not the value on disk. Without it, an optimistic row and a
    // saved row are indistinguishable.
    await waitFor(() =>
      expect(
        libraryView(container).getByTitle(
          "Write metadata changes made earlier (not yet saved to the files) into the files",
        ),
      ).toBeInTheDocument(),
    );
  });

  it("keeps the pending edit when the write failed", async () => {
    fake.failItem(TRACK, "lofty: unsupported tag");

    const { container } = render(<App />);
    const user = await openEditor(container);
    await user.clear(field("Title"));
    await user.type(field("Title"), "After");
    await user.click(screen.getByRole("button", { name: /confirm/i }));

    await waitFor(() => expect(fake.called("write_metadata")).toBe(true));

    // The edit is still recorded and still offered for a retry. Clearing it
    // would lose the user's intent with nothing on disk to show for it.
    expect(fake.called("edit_clear")).toBe(false);
    expect(
      await screen.findByTitle(
        "Write metadata changes made earlier (not yet saved to the files) into the files",
      ),
    ).toBeInTheDocument();
  });
});
