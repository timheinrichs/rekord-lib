import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import StatusIcons from "./StatusIcons";
import type { TrackStatus } from "../lib/format";

const CONVERT: TrackStatus = {
  kind: "convert",
  title: "Needs conversion\nbad rate",
};
const BANDCAMP: TrackStatus = { kind: "bandcamp", title: "From Bandcamp" };

describe("StatusIcons", () => {
  it("renders nothing when there is no status", () => {
    const { container } = render(<StatusIcons items={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("exposes each marker by its tooltip text", () => {
    render(<StatusIcons items={[CONVERT, BANDCAMP]} />);
    expect(
      screen.getByRole("img", { name: "Needs conversion\nbad rate" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "From Bandcamp" })).toBeInTheDocument();
  });

  it("appends a count when one is given", () => {
    render(<StatusIcons items={[CONVERT]} counts={{ convert: 3 }} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Needs conversion\nbad rate (3)" }),
    ).toBeInTheDocument();
  });

  it("ignores a count for a kind that is not shown", () => {
    render(<StatusIcons items={[BANDCAMP]} counts={{ convert: 3 }} />);
    expect(screen.queryByText("3")).not.toBeInTheDocument();
  });

  it("spells the status out in label mode, keeping detail in the tooltip", () => {
    render(<StatusIcons items={[CONVERT]} withLabels />);
    // Only the first tooltip line becomes the visible label.
    expect(screen.getByText("Needs conversion")).toBeInTheDocument();
    expect(screen.queryByText(/bad rate/)).not.toBeInTheDocument();
  });

  it("shows a dash instead of nothing in label mode", () => {
    render(<StatusIcons items={[]} withLabels />);
    expect(screen.getByText("–")).toBeInTheDocument();
  });
});
