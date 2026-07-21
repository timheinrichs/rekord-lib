import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import BulkMetadataEditor, { type BulkPatch } from "./BulkMetadataEditor";

/** Row = the div that contains the field label; grab its checkbox / text input. */
function row(labelText: string): HTMLDivElement {
  const div = screen.getByText(labelText).closest("div");
  if (!div) throw new Error(`no row for ${labelText}`);
  return div as HTMLDivElement;
}
const checkbox = (label: string) =>
  row(label).querySelector('input[type="checkbox"]') as HTMLInputElement;
const textInput = (label: string) =>
  row(label).querySelector('input:not([type="checkbox"])') as HTMLInputElement;

describe("BulkMetadataEditor", () => {
  it("offers Label and Catalog no. as bulk fields", () => {
    render(<BulkMetadataEditor count={3} onClose={() => {}} onApply={() => {}} />);
    expect(screen.getByText("Label")).toBeInTheDocument();
    expect(screen.getByText("Catalog no.")).toBeInTheDocument();
  });

  it("keeps Apply disabled until a field is enabled", async () => {
    render(<BulkMetadataEditor count={2} onClose={() => {}} onApply={() => {}} />);
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    await userEvent.click(checkbox("Label"));
    expect(apply).toBeEnabled();
  });

  it("applies only enabled fields", async () => {
    const onApply = vi.fn();
    render(<BulkMetadataEditor count={2} onClose={() => {}} onApply={onApply} />);
    await userEvent.click(checkbox("Label"));
    await userEvent.type(textInput("Label"), "Hessle Audio");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    const patch = onApply.mock.calls[0][0] as BulkPatch;
    expect(patch).toEqual({ label: "Hessle Audio" });
    expect(patch).not.toHaveProperty("catalog_number");
  });

  it("maps an enabled but empty field to null (clears it)", async () => {
    const onApply = vi.fn();
    render(<BulkMetadataEditor count={2} onClose={() => {}} onApply={onApply} />);
    await userEvent.click(checkbox("Catalog no."));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    const patch = onApply.mock.calls[0][0] as BulkPatch;
    expect(patch).toEqual({ catalog_number: null });
  });
});
