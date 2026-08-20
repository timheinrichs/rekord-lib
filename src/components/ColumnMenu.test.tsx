import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ColumnMenu from "./ColumnMenu";
import type { ColumnId } from "../lib/columns";

async function open(hidden: ColumnId[] = []) {
  const onChange = vi.fn();
  render(<ColumnMenu hidden={hidden} onChange={onChange} />);
  await userEvent.click(screen.getByRole("button", { name: "Choose columns" }));
  return { onChange };
}

describe("ColumnMenu", () => {
  it("offers the optional columns and not the ones that operate the table", async () => {
    // Hiding selection or hierarchy would leave a list that cannot be acted on,
    // which is a broken state rather than a preference.
    await open();
    expect(screen.getByText("Waveform")).toBeTruthy();
    expect(screen.getByText("BPM")).toBeTruthy();
    expect(screen.getByText("Key")).toBeTruthy();
    expect(screen.queryByText("Title")).toBeNull();
  });

  it("shows every column as on by default", async () => {
    await open();
    const boxes = screen
      .getAllByRole("checkbox")
      .map((b) => (b as HTMLInputElement).checked);
    expect(boxes.every((c) => c)).toBe(true);
  });

  it("reports the column that was switched off", async () => {
    const { onChange } = await open();
    await userEvent.click(screen.getByText("Album"));
    expect(onChange).toHaveBeenCalledWith(["album"]);
  });

  it("switches one back on without touching the others", async () => {
    const { onChange } = await open(["album", "format"]);
    await userEvent.click(screen.getByText("Album"));
    expect(onChange).toHaveBeenCalledWith(["format"]);
  });

  it("offers a way back once anything is hidden", async () => {
    const { onChange } = await open(["album"]);
    await userEvent.click(screen.getByText("Show all"));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("has nothing to reset when everything is shown", async () => {
    await open();
    expect(screen.queryByText("Show all")).toBeNull();
  });

  it("marks the button while columns are hidden", async () => {
    // Otherwise a missing column looks like a bug rather than a choice.
    render(<ColumnMenu hidden={["album"]} onChange={() => {}} />);
    const button = screen.getByRole("button", { name: "Choose columns" });
    expect(button.querySelector("span")).not.toBeNull();
  });

  it("is unmarked when nothing is hidden", () => {
    render(<ColumnMenu hidden={[]} onChange={() => {}} />);
    const button = screen.getByRole("button", { name: "Choose columns" });
    expect(button.querySelector("span")).toBeNull();
  });
});
