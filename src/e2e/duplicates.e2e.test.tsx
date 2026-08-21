/**
 * Resolving duplicates, from the header button to files in the trash.
 *
 * `DuplicatesModal.tsx` has no test file, and `TODO.md` says why that is worse
 * than it sounds: it is the panel that decides which files get deleted. So the
 * assertions here are about *which* paths leave and which stay, not about the
 * layout.
 *
 * The other thing this flow is the only place to see is that a dismissal and a
 * deletion are different persistence: a dismissal is stored apart from the
 * result, because every new search overwrites the result and the "not a
 * duplicate" decision has to survive that.
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { libraryView } from "../test/appDom";
import { makeMetadata, makeTrack } from "../test/factories";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";
import type { DuplicateFile, DuplicateGroup } from "../types";

const LIBRARY = "/fixture/library";
const ORIGINAL = `${LIBRARY}/Duplicates/original.aiff`;
const COPY = `${LIBRARY}/Duplicates/nested/copy.aiff`;

let fake: FakeBackend;

function dupFile(path: string, over: Partial<DuplicateFile> = {}): DuplicateFile {
  return {
    id: path,
    path,
    file_name: path.split("/").pop() ?? path,
    codec: "pcm_s16be",
    container: "aiff",
    sample_rate: 44_100,
    bits_per_sample: 16,
    lossless: true,
    duration_secs: 30,
    compatible: true,
    size_bytes: 5_292_000,
    title: "Original",
    artist: "Artist",
    album: "Album",
    ...over,
  };
}

/** The fixture's duplicate pair: identical audio, two names, two folders. */
function group(): DuplicateGroup {
  return {
    id: ORIGINAL,
    keep_id: ORIGINAL,
    files: [dupFile(ORIGINAL), dupFile(COPY)],
  };
}

beforeEach(() => {
  fake = installFakeBackend({
    files: [ORIGINAL, COPY],
    tracks: [
      makeTrack({
        path: ORIGINAL,
        file_name: "original.aiff",
        metadata: makeMetadata({ title: "Original" }),
      }),
      makeTrack({
        path: COPY,
        file_name: "copy.aiff",
        metadata: makeMetadata({ title: "Copy" }),
      }),
    ],
    groups: [group()],
    store: { settings: { library_dir: LIBRARY } },
  });
});

afterEach(() => {
  cleanup();
  fake.restore();
});

async function openModal(container: HTMLElement) {
  const user = userEvent.setup();
  const open = await waitFor(() =>
    libraryView(container).getByTitle(
      "Show the duplicate tracks found across all formats",
    ),
  );
  await user.click(open);
  // The modal portals into document.body, so it is not inside the render
  // container and has to be reached through `screen`.
  const dialog = await screen.findByText("Duplicates");
  const panel = dialog.closest("div.flex.flex-col");
  if (!panel) throw new Error("no duplicates panel");
  return { user, panel: within(panel as HTMLElement) };
}

describe("duplicates", () => {
  it("lists the stored group", async () => {
    const { container } = render(<App />);
    const { panel } = await openModal(container);

    expect(panel.getByTitle(ORIGINAL)).toBeInTheDocument();
    expect(panel.getByTitle(COPY)).toBeInTheDocument();
  });

  it("trashes only the file the panel offers to delete", async () => {
    const { container } = render(<App />);
    const { user, panel } = await openModal(container);

    // The kept file has no trash button at all — it carries a "Keep" pill
    // instead. So the panel offers exactly one deletion, and asserting that is
    // stronger than finding the right row: there is no button next to the file
    // it suggested keeping.
    const offered = panel.getAllByRole("button", { name: "Move to trash" });
    expect(offered).toHaveLength(1);
    expect(panel.getByText("Keep")).toBeInTheDocument();

    await user.click(offered[0]);

    await waitFor(() => expect(fake.called("delete_files")).toBe(true));
    const [args] = fake.argsFor("delete_files");
    // Exactly one path, and it is the copy. Deleting the kept file instead
    // would be the worst thing this panel could do.
    expect(args.paths).toEqual([COPY]);
    expect(fake.state.files).toEqual([ORIGINAL]);
  });

  it("prunes the folder the deleted file left behind", async () => {
    const { container } = render(<App />);
    const { user, panel } = await openModal(container);

    await user.click(panel.getByRole("button", { name: "Move to trash" }));

    // The copy was the only file in `nested/`, so that folder is offered for
    // pruning. The backend re-checks before trashing it.
    await waitFor(() => expect(fake.called("prune_empty_dirs")).toBe(true));
    expect(fake.argsFor("prune_empty_dirs")[0].dirs).toEqual([
      `${LIBRARY}/Duplicates/nested`,
    ]);
  });

  it("stores a dismissal apart from the result, and deletes nothing", async () => {
    const { container } = render(<App />);
    const { user, panel } = await openModal(container);

    await user.click(
      panel.getByTitle("This group is not a duplicate – remove it from the list"),
    );

    await waitFor(() => expect(fake.called("duplicates_dismiss")).toBe(true));
    expect(fake.argsFor("duplicates_dismiss")[0].id).toBe(ORIGINAL);
    // A dismissal is not a deletion. Both files are still there.
    expect(fake.called("delete_files")).toBe(false);
    expect(fake.state.files).toEqual([ORIGINAL, COPY]);
  });

  it("says so when there is nothing to resolve", async () => {
    fake.state.groups = [];
    const { container } = render(<App />);

    // With no groups the header button is not offered at all.
    await waitFor(() => expect(fake.called("library_load")).toBe(true));
    expect(
      libraryView(container).queryByTitle(
        "Show the duplicate tracks found across all formats",
      ),
    ).not.toBeInTheDocument();
  });
});
