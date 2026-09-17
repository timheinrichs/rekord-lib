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

  it("ships both logo variants and lets CSS pick one", () => {
    // The wordmark is paths and must not be recoloured, so the light and dark
    // files are both rendered and the `dark:` variant hides one. A JS swap
    // could disagree with the theme actually applied; a class cannot.
    const { container } = render(<AppHeader title="Library" />);
    const logos = container.querySelectorAll("header img");
    expect(logos).toHaveLength(2);
    const [light, dark] = Array.from(logos);
    expect(light.className).toContain("dark:hidden");
    expect(dark.className).toContain("dark:block");
    expect(dark.className).toContain("hidden");
    // Only one of them names the app, or a screen reader says it twice.
    expect(
      Array.from(logos).filter((l) => l.getAttribute("alt")),
    ).toHaveLength(1);
    expect(screen.getByAltText("rekord-lib")).toBe(light);
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
