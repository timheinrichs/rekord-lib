import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AppHeader, { BuildChip } from "./AppHeader";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("BuildChip", () => {
  it("marks a development build", () => {
    vi.stubEnv("DEV", true);
    render(<BuildChip />);
    const chip = screen.getByTitle("Development build");
    expect(chip).toHaveTextContent("dev");
    expect(chip).toHaveClass("text-fg-warning");
  });

  it("marks a shipped build as beta, in accent rather than a status colour", () => {
    vi.stubEnv("DEV", false);
    render(<BuildChip />);
    const chip = screen.getByTitle("Beta build – expect rough edges");
    expect(chip).toHaveTextContent("Beta");
    expect(chip).toHaveClass("text-fg-accent");
    expect(chip).not.toHaveClass("text-fg-warning");
  });
});

describe("AppHeader", () => {
  it("shows the logo and the build chip", () => {
    vi.stubEnv("DEV", false);
    render(<AppHeader title="Library" />);
    expect(screen.getByAltText("rekord-lib")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("names the screen in a heading the design has no room for", () => {
    // The visible header is a logo and a row of actions. The screen still has a
    // name, and a document still needs one top-level heading.
    render(<AppHeader title="Library" />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Library");
    expect(h1).toHaveClass("sr-only");
  });

  it("renders the actions slot", () => {
    render(<AppHeader title="Library" right={<button>Rescan</button>} />);
    expect(screen.getByRole("button", { name: "Rescan" })).toBeInTheDocument();
  });
});
