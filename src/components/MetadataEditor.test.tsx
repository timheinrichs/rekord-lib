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
