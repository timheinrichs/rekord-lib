/**
 * Conversion, from the row's button to the result on the row.
 *
 * `TODO.md` lists `commands::convert_tracks` as untested, and says why it
 * matters: the rename over the source, the `replace_source` trash and three
 * cleanup branches move the user's files. Those live in Rust and belong to the
 * wdio suite. What belongs here is everything the frontend decides *before* the
 * files move — and the option that decides whether they move at all.
 *
 * The trap this flow exists for: `convert_tracks` has a plain return type, so it
 * never rejects. A failure arrives as `success: false` with an `error` inside an
 * otherwise successful result, and a view that only handles a rejected promise
 * shows a failed conversion as a finished one.
 */
import { cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "../App";
import { libraryView } from "../test/appDom";
import { makeAudio, makeCompat, makeMetadata, makeTrack } from "../test/factories";
import { installFakeBackend, type FakeBackend } from "../test/fakeBackend";
import type { ConvertOptions } from "../types";

const LIBRARY = "/fixture/library";
const NEEDS_WORK = `${LIBRARY}/96khz-24bit.aiff`;

let fake: FakeBackend;

/** A track the compatibility rules reject, which is what shows the button. */
function incompatible() {
  return makeTrack({
    path: NEEDS_WORK,
    file_name: "96khz-24bit.aiff",
    metadata: makeMetadata({ title: "Ninety Six" }),
    audio: makeAudio({ sample_rate: 96_000, bits_per_sample: 24 }),
    compat: makeCompat({
      compatible: false,
      issues: [
        {
          code: "sample_rate",
          message: "96 kHz is not supported",
          severity: "error",
        },
      ],
    }),
  });
}

beforeEach(() => {
  fake = installFakeBackend({
    files: [NEEDS_WORK],
    tracks: [incompatible()],
    store: {
      settings: {
        library_dir: LIBRARY,
        format: "aiff",
        bit_depth: 16,
        sanitize_filenames: true,
      },
    },
  });
});

afterEach(() => {
  cleanup();
  fake.restore();
});

async function rowFor(container: HTMLElement) {
  const cell = await waitFor(() => libraryView(container).getByTitle(NEEDS_WORK));
  const tr = cell.closest("tr");
  if (!tr) throw new Error("no row");
  return within(tr);
}

describe("conversion", () => {
  it("converts in place and asks for the source to be replaced", async () => {
    const user = userEvent.setup();
    const { container } = render(<App />);
    const row = await rowFor(container);

    await user.click(row.getByRole("button", { name: "Convert" }));

    await waitFor(() => expect(fake.called("convert_tracks")).toBe(true));
    const [args] = fake.argsFor("convert_tracks");
    const options = args.options as ConvertOptions;

    // A track already in the library is converted where it lies, and the
    // original goes to the trash afterwards. Both halves of that are one
    // decision, and this is where it is made.
    expect(options.output_dir).toBeNull();
    expect(options.replace_source).toBe(true);
    // The settings reach the backend rather than a default being re-derived.
    expect(options.format).toBe("aiff");
    expect(options.bit_depth).toBe(16);
    expect(options.sanitize_filenames).toBe(true);

    // One job, naming the file it is about.
    const jobs = args.jobs as { id: string; path: string }[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0].path).toBe(NEEDS_WORK);

    // No folder dialog: the output folder is not a question for this mode.
    expect(fake.called("plugin:dialog|open")).toBe(false);
  });

  it("shows progress while a file is being converted", async () => {
    const user = userEvent.setup();
    // Held open, because the real command answers only once its last job is
    // done. Without this the result would already be on the row before a
    // progress event could be emitted, and the in-flight state would be
    // untestable.
    const finish = fake.hold("convert_tracks");

    const { container } = render(<App />);
    const row = await rowFor(container);
    await user.click(row.getByRole("button", { name: "Convert" }));
    await waitFor(() => expect(fake.called("convert_tracks")).toBe(true));

    const [args] = fake.argsFor("convert_tracks");
    const id = (args.jobs as { id: string }[])[0].id;

    await fake.emit("convert://progress", { id, percent: 42, stage: "encoding" });

    await waitFor(() =>
      expect(
        libraryView(container).getByTitle("Converting – 42%"),
      ).toBeInTheDocument(),
    );

    // And the finished result replaces the progress rather than joining it.
    finish();
    await waitFor(() =>
      expect(
        libraryView(container).getByTitle("Converted"),
      ).toBeInTheDocument(),
    );
    expect(
      libraryView(container).queryByTitle("Converting – 42%"),
    ).not.toBeInTheDocument();
  });

  it("reports a failure that arrives inside a successful return", async () => {
    const user = userEvent.setup();
    // Not a rejection: `convert_tracks` has a plain return type and cannot
    // reject. This is the shape the real backend uses for a file it could not
    // write — and the shape a view is most likely to read as success.
    fake.failItem(NEEDS_WORK, "ffmpeg exit 1: Invalid data found");

    const { container } = render(<App />);
    const row = await rowFor(container);
    await user.click(row.getByRole("button", { name: "Convert" }));

    // The row says it failed…
    await waitFor(() =>
      expect(
        libraryView(container).getByTitle("ffmpeg exit 1: Invalid data found"),
      ).toBeInTheDocument(),
    );
    // …and does not also say it succeeded.
    expect(
      libraryView(container).queryByTitle("Converted"),
    ).not.toBeInTheDocument();
  });

  it("keeps the row's edits when the conversion did not replace anything", async () => {
    const user = userEvent.setup();
    // A failed conversion must not clear the pending edit for that path: the
    // edit describes tags that are still unwritten, and the file it belongs to
    // is still there.
    fake.failItem(NEEDS_WORK, "ffmpeg exit 1");
    fake.state.edits = {
      [NEEDS_WORK]: { metadata: makeMetadata({ title: "Edited" }), cover: { kind: "keep" } },
    };

    const { container } = render(<App />);
    const row = await rowFor(container);
    await user.click(row.getByRole("button", { name: "Convert" }));

    await waitFor(() => expect(fake.called("convert_tracks")).toBe(true));
    expect(fake.called("edit_clear")).toBe(false);
  });
});
