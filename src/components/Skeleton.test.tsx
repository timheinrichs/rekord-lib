import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  CollectionSkeleton,
  Skeleton,
  TrackTableSkeleton,
} from "./Skeleton";

describe("Skeleton", () => {
  it("pulses and is hidden from assistive tech", () => {
    const { container } = render(<Skeleton className="h-4 w-32" />);
    const el = container.firstChild as HTMLElement;
    expect(el).toHaveClass("animate-skeleton");
    expect(el).toHaveAttribute("aria-hidden", "true");
    expect(el).toHaveClass("h-4", "w-32");
  });
});

describe("TrackTableSkeleton", () => {
  it("announces itself as a loading status", () => {
    render(<TrackTableSkeleton />);
    expect(
      screen.getByRole("status", { name: "Loading library" }),
    ).toBeInTheDocument();
  });

  it("renders the requested number of rows", () => {
    const { container } = render(<TrackTableSkeleton rows={3} />);
    expect(container.querySelectorAll(".h-16")).toHaveLength(3);
  });

  it("defaults to eight rows", () => {
    const { container } = render(<TrackTableSkeleton />);
    expect(container.querySelectorAll(".h-16")).toHaveLength(8);
  });

  it("renders no table rows, so it can never sit inside the virtualized tbody", () => {
    const { container } = render(<TrackTableSkeleton rows={2} />);
    expect(container.querySelectorAll("tr")).toHaveLength(0);
  });
});

describe("CollectionSkeleton", () => {
  it("renders list rows by default", () => {
    render(<CollectionSkeleton rows={4} />);
    const status = screen.getByRole("status", { name: "Loading collection" });
    expect(status).toBeInTheDocument();
    expect(status).not.toHaveClass("grid");
  });

  it("switches to a grid on request", () => {
    render(<CollectionSkeleton rows={4} grid />);
    expect(
      screen.getByRole("status", { name: "Loading collection" }),
    ).toHaveClass("grid");
  });
});
