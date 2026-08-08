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
    expect(chip).toHaveClass("text-warning-500");
  });

  it("marks a shipped build as beta, in accent rather than a status colour", () => {
    vi.stubEnv("DEV", false);
    render(<BuildChip />);
    const chip = screen.getByTitle("Beta build – expect rough edges");
    expect(chip).toHaveTextContent("Beta");
    expect(chip).toHaveClass("text-accent-300");
    expect(chip).not.toHaveClass("text-warning-500");
  });
});

describe("AppHeader", () => {
  it("shows the logo and the build chip", () => {
    vi.stubEnv("DEV", false);
    render(<AppHeader />);
    expect(screen.getByAltText("rekord-lib")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("renders the actions slot", () => {
    render(<AppHeader right={<button>Rescan</button>} />);
    expect(screen.getByRole("button", { name: "Rescan" })).toBeInTheDocument();
  });
});
