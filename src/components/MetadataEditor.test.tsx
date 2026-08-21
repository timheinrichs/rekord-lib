import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MetadataEditor from "./MetadataEditor";
import { makeMetadata, makeTrack } from "../test/factories";
import type { TrackEdit } from "../types";

vi.mock("../lib/api", () => ({
  suggestMetadata: vi.fn(async () => ({
    id: "x",
    current: null,
    filename_guess: {},
    candidates: [],
    field_suggestions: {
      genres: ["Deep House"],
      years: [],
      labels: [],
      countries: ["Germany"],
    },
  })),
  coverPreview: vi.fn(async () => "data:image/jpeg;base64,AA"),
  pickImageFile: vi.fn(async () => null),
}));

const { revealMock } = vi.hoisted(() => ({ revealMock: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: revealMock }));

/** The form inputs have no htmlFor; locate them via their label text. */
function fieldInput(labelText: string): HTMLInputElement {
  const span = screen.getByText(labelText);
  const input = span.closest("label")?.querySelector("input");
  if (!input) throw new Error(`no input for ${labelText}`);
  return input as HTMLInputElement;
}

describe("MetadataEditor", () => {
  beforeEach(() => vi.clearAllMocks());

  it("renders the new Label and Catalog no. fields", async () => {
    render(
      <MetadataEditor track={makeTrack()} onClose={() => {}} onSave={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("Label")).toBeInTheDocument());
    expect(screen.getByText("Catalog no.")).toBeInTheDocument();
  });

  it("keeps a typed decimal tempo, comma included", async () => {
    // parseInt used to truncate this to 127, silently rewriting the user's tag.
    const saved: TrackEdit[] = [];
    const track = makeTrack({ metadata: makeMetadata({ bpm: null }) });
    render(
      <MetadataEditor
        track={track}
        onClose={() => {}}
        onSave={(e) => saved.push(e)}
      />,
    );
    await userEvent.click(screen.getByTitle("Edit BPM"));
    await userEvent.type(screen.getByPlaceholderText("–"), "127,6");
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(saved[0].metadata.bpm).toBe(127.6);
  });

  it("shows a rounded tempo but saves the stored one untouched", async () => {
    // The display is whole beats, the file holds 127.61. Writing the field back
    // verbatim would round the decimals away on every save — including one that
    // only changed the genre.
    const saved: TrackEdit[] = [];
    const track = makeTrack({ metadata: makeMetadata({ bpm: 127.61 }) });
    render(
      <MetadataEditor
        track={track}
        onClose={() => {}}
        onSave={(e) => saved.push(e)}
      />,
    );
    expect(screen.getByTitle("Edit BPM").textContent).toBe("128");
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(saved[0].metadata.bpm).toBe(127.61);
  });

  it("keeps the stored tempo when an unrelated field is edited", async () => {
    const saved: TrackEdit[] = [];
    const track = makeTrack({ metadata: makeMetadata({ bpm: 127.61 }) });
    render(
      <MetadataEditor
        track={track}
        onClose={() => {}}
        onSave={(e) => saved.push(e)}
      />,
    );
    await userEvent.type(fieldInput("Genre"), "Electro");
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(saved[0].metadata.bpm).toBe(127.61);
  });

  it("takes a real edit of the tempo", async () => {
    const saved: TrackEdit[] = [];
    const track = makeTrack({ metadata: makeMetadata({ bpm: 127.61 }) });
    render(
      <MetadataEditor
        track={track}
        onClose={() => {}}
        onSave={(e) => saved.push(e)}
      />,
    );
    await userEvent.click(screen.getByTitle("Edit BPM"));
    const input = screen.getByDisplayValue("128");
    await userEvent.clear(input);
    await userEvent.type(input, "140");
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(saved[0].metadata.bpm).toBe(140);
  });

  it("shows a detected key, and that it stayed out of the file", async () => {
    const track = makeTrack({ key: "Am", key_camelot: "8A", key_confidence: 0.42 });
    render(<MetadataEditor track={track} onClose={() => {}} onSave={() => {}} />);
    // The name as a musician writes it; the mode spelled out and the Camelot
    // position on hover, where they inform without competing for the line.
    expect(screen.getByText("Am")).toHaveAttribute("title", "A minor · 8A");
    const label = screen.getByText("42% sure");
    expect(label.getAttribute("title")).toMatch(/never written into the file/);
  });

  it("offers no way to edit the key", async () => {
    // Read-only on purpose: it is never written into the file, so an editable
    // field would promise something the app does not do.
    const saved: TrackEdit[] = [];
    const track = makeTrack({ key: "Am", key_camelot: "8A", key_confidence: 0.42 });
    render(
      <MetadataEditor track={track} onClose={() => {}} onSave={(e) => saved.push(e)} />,
    );
    expect(screen.queryByTitle("Edit key")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /confirm/i }));
    // And nothing key-shaped travels through the write path.
    expect("key" in saved[0].metadata).toBe(false);
  });

  it("shows a dash where no key was detected", async () => {
    const track = makeTrack({ key: null, key_camelot: null, key_confidence: null });
    render(<MetadataEditor track={track} onClose={() => {}} onSave={() => {}} />);
    const row = screen.getByText("Key").parentElement;
    expect(row?.textContent).toContain("–");
    expect(screen.queryByText(/% sure/)).toBeNull();
  });

  it("says so when a detected tempo never reached the file", async () => {
    // The row and the file disagree in exactly this case, and nothing else in
    // the UI would tell the user.
    const track = makeTrack({
      metadata: makeMetadata({ bpm: 128 }),
      bpm_confidence: 0.12,
    });
    render(<MetadataEditor track={track} onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByText(/12% sure, not written/)).toBeTruthy();
  });

  it("reports a confident detection without alarming about it", async () => {
    const track = makeTrack({
      metadata: makeMetadata({ bpm: 128 }),
      bpm_confidence: 0.93,
    });
    render(<MetadataEditor track={track} onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByText("93% sure")).toBeTruthy();
  });

  it("shows nothing about confidence for a tempo read from the tag", async () => {
    const track = makeTrack({
      metadata: makeMetadata({ bpm: 128 }),
      bpm_confidence: null,
    });
    render(<MetadataEditor track={track} onClose={() => {}} onSave={() => {}} />);
    expect(screen.queryByText(/sure/)).toBeNull();
  });

  it("shows a disabled path field and reveals it in Finder", async () => {
    const track = makeTrack({ path: "/music/Album/song.aiff" });
    render(<MetadataEditor track={track} onClose={() => {}} onSave={() => {}} />);
    const pathInput = fieldInput("Path");
    expect(pathInput.value).toBe("/music/Album/song.aiff");
    expect(pathInput.disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Open in Finder" }));
    expect(revealMock).toHaveBeenCalledWith("/music/Album/song.aiff");
  });

  it("disables Confirm when a required field is empty", async () => {
    render(
      <MetadataEditor track={makeTrack()} onClose={() => {}} onSave={() => {}} />,
    );
    const confirm = screen.getByRole("button", { name: "Confirm" });
    expect(confirm).toBeEnabled();
    await userEvent.clear(fieldInput("Title"));
    expect(confirm).toBeDisabled();
  });

  it("saves catalog number and label entered by the user", async () => {
    const onSave = vi.fn();
    render(
      <MetadataEditor track={makeTrack()} onClose={() => {}} onSave={onSave} />,
    );
    await waitFor(() => expect(screen.getByText("Label")).toBeInTheDocument());
    await userEvent.type(fieldInput("Label"), "Warp Records");
    await userEvent.type(fieldInput("Catalog no."), "WARP-042");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const edit = onSave.mock.calls[0][0] as TrackEdit;
    expect(edit.metadata.label).toBe("Warp Records");
    expect(edit.metadata.catalog_number).toBe("WARP-042");
  });

  it("applies a per-field suggestion chip (genre/country)", async () => {
    const onSave = vi.fn();
    render(
      <MetadataEditor track={makeTrack()} onClose={() => {}} onSave={onSave} />,
    );
    // Chips appear once suggestions load.
    const genreChip = await screen.findByRole("button", { name: "Deep House" });
    await userEvent.click(genreChip);
    await userEvent.click(screen.getByRole("button", { name: "Germany" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    const edit = onSave.mock.calls[0][0] as TrackEdit;
    expect(edit.metadata.genre).toBe("Deep House");
    expect(edit.metadata.country).toBe("Germany");
  });

  it("prefills fields from an existing edit", async () => {
    const initial: TrackEdit = {
      metadata: makeMetadata({ label: "Existing Label", catalog_number: "CAT-1" }),
      cover: { kind: "keep" },
    };
    render(
      <MetadataEditor
        track={makeTrack()}
        initial={initial}
        onClose={() => {}}
        onSave={() => {}}
      />,
    );
    await waitFor(() => expect(fieldInput("Label").value).toBe("Existing Label"));
    expect(fieldInput("Catalog no.").value).toBe("CAT-1");
  });
});
