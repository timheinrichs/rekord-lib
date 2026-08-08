import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import FilterMenu from "./FilterMenu";
import { EMPTY_FILTER, type FilterCounts, type TrackFilter } from "../lib/trackFilter";

const COUNTS: FilterCounts = {
  total: 10,
  needsConvert: 3,
  incomplete: 2,
  bandcamp: 4,
  local: 6,
};

function setup(filter: TrackFilter = EMPTY_FILTER, genres = ["House", "Techno"]) {
  const onChange = vi.fn();
  render(
    <FilterMenu
      filter={filter}
      onChange={onChange}
      genres={genres}
      counts={COUNTS}
    />,
  );
  return { onChange, user: userEvent.setup() };
}

/**
 * Stateful wrapper for the cases that type into a field: the inputs are
 * controlled, so without a real state update React resets the value after
 * every keystroke and "120" would never arrive as 120.
 */
function Harness({ initial = EMPTY_FILTER }: { initial?: TrackFilter }) {
  const [filter, setFilter] = useState(initial);
  return (
    <>
      <FilterMenu
        filter={filter}
        onChange={setFilter}
        genres={["House", "Techno"]}
        counts={COUNTS}
      />
      <output data-testid="state">{JSON.stringify(filter)}</output>
    </>
  );
}

const state = () => JSON.parse(screen.getByTestId("state").textContent ?? "{}");

const openButton = () => screen.getByRole("button", { name: "Filter tracks" });

describe("FilterMenu", () => {
  it("keeps the popover closed until the button is pressed", async () => {
    const { user } = setup();
    expect(screen.queryByText("Reset all")).not.toBeInTheDocument();
    await user.click(openButton());
    expect(screen.getByText("Reset all")).toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const { user } = setup();
    await user.click(openButton());
    await user.keyboard("{Escape}");
    expect(screen.queryByText("Reset all")).not.toBeInTheDocument();
  });

  it("closes on a press outside", async () => {
    const { user } = setup();
    await user.click(openButton());
    await user.click(document.body);
    expect(screen.queryByText("Reset all")).not.toBeInTheDocument();
  });

  it("stays open when the popover itself is used", async () => {
    const { user } = setup();
    await user.click(openButton());
    await user.click(screen.getByLabelText("Minimum BPM"));
    expect(screen.getByText("Reset all")).toBeInTheDocument();
  });

  it("takes a full BPM range as typed", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(openButton());
    await user.type(screen.getByLabelText("Minimum BPM"), "120");
    await user.type(screen.getByLabelText("Maximum BPM"), "130");
    expect(state()).toMatchObject({ bpmMin: 120, bpmMax: 130 });
  });

  it("clears a bound when its field is emptied", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ ...EMPTY_FILTER, bpmMax: 130 }} />);
    await user.click(openButton());
    await user.clear(screen.getByLabelText("Maximum BPM"));
    expect(state()).toMatchObject({ bpmMax: null });
  });

  it("takes a year range", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(openButton());
    await user.type(screen.getByLabelText("Earliest year"), "2020");
    expect(state()).toMatchObject({ yearMin: 2020, yearMax: null });
  });

  it("toggles a genre on and off", async () => {
    const { onChange, user } = setup();
    await user.click(openButton());
    await user.click(screen.getByRole("checkbox", { name: /Techno/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...EMPTY_FILTER,
      genres: ["Techno"],
    });
  });

  it("removes an already selected genre", async () => {
    const { onChange, user } = setup({ ...EMPTY_FILTER, genres: ["Techno"] });
    await user.click(openButton());
    await user.click(screen.getByRole("checkbox", { name: /Techno/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_FILTER, genres: [] });
  });

  it("says so when nothing is tagged with a genre", async () => {
    const { user } = setup(EMPTY_FILTER, []);
    await user.click(openButton());
    expect(screen.getByText("No genres tagged yet.")).toBeInTheDocument();
  });

  it("shows the counts next to the status and source options", async () => {
    const { user } = setup();
    await user.click(openButton());
    expect(screen.getByRole("checkbox", { name: /To convert/ })).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("toggles a source", async () => {
    const { onChange, user } = setup();
    await user.click(openButton());
    await user.click(screen.getByRole("checkbox", { name: /Bandcamp/ }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...EMPTY_FILTER,
      sources: ["bandcamp"],
    });
  });

  it("disables reset while nothing is filtered", async () => {
    const { user } = setup();
    await user.click(openButton());
    expect(screen.getByText("Reset all")).toBeDisabled();
  });

  it("resets every facet at once", async () => {
    const { onChange, user } = setup({
      ...EMPTY_FILTER,
      bpmMin: 120,
      genres: ["Techno"],
      needsConvert: true,
    });
    await user.click(openButton());
    await user.click(screen.getByText("Reset all"));
    expect(onChange).toHaveBeenCalledWith(EMPTY_FILTER);
  });

  it("marks the button only while a filter is active", () => {
    const { unmount } = render(
      <FilterMenu
        filter={EMPTY_FILTER}
        onChange={() => {}}
        genres={[]}
        counts={COUNTS}
      />,
    );
    expect(openButton().querySelector("span")).toBeNull();
    unmount();

    render(
      <FilterMenu
        filter={{ ...EMPTY_FILTER, needsConvert: true }}
        onChange={() => {}}
        genres={[]}
        counts={COUNTS}
      />,
    );
    expect(openButton().querySelector("span")).not.toBeNull();
  });
});
