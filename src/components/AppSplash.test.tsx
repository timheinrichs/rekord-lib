import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import AppSplash from "./AppSplash";
import { STAGE_BPM, type ScanProgress } from "../types";

const scanning: ScanProgress = {
  generation: 1,
  done: 412,
  total: 2223,
  running: true,
  stage: STAGE_BPM,
};

describe("AppSplash", () => {
  it("shows the logo", () => {
    render(<AppSplash phase="starting" />);
    expect(screen.getByRole("img", { name: "rekord-lib" })).toBeInTheDocument();
  });

  it("reports the current phase", () => {
    const { rerender } = render(<AppSplash phase="starting" />);
    expect(screen.getByText("Starting app…")).toBeInTheDocument();
    rerender(<AppSplash phase="library" />);
    expect(screen.getByText("Loading library…")).toBeInTheDocument();
  });

  it("includes the scan counters while scanning", () => {
    render(<AppSplash phase="scanning" progress={scanning} />);
    expect(screen.getByText("BPM 412/2223")).toBeInTheDocument();
  });

  it("animates the four bars with a stagger", () => {
    const { container } = render(<AppSplash phase="starting" />);
    const bars = container.querySelectorAll(".eq-bar");
    expect(bars).toHaveLength(4);
    expect(bars[0]).toHaveStyle({ animationDelay: "0ms" });
    expect(bars[3]).toHaveStyle({ animationDelay: "360ms" });
  });

  it("fades out only once it is leaving", () => {
    const { container, rerender } = render(<AppSplash phase="ready" />);
    expect(container.firstChild).not.toHaveClass("animate-fade-out");
    rerender(<AppSplash phase="ready" leaving />);
    expect(container.firstChild).toHaveClass("animate-fade-out");
  });

  it("is announced as a status", () => {
    render(<AppSplash phase="library" />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
