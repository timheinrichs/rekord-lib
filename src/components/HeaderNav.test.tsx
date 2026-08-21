import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import HeaderNav from "./HeaderNav";
import type { Severity } from "../lib/changelog";
import type { EventLevel } from "../types";

function renderNav(over: {
  updateAvailable?: boolean;
  updateSeverity?: Severity | null;
  eventBadge?: EventLevel | null;
}) {
  return render(
    <HeaderNav
      view="library"
      onNavigate={() => {}}
      downloads={{}}
      onCancelDownload={() => {}}
      onClearDownloads={() => {}}
      onOpenSettings={() => {}}
      onOpenEventLog={() => {}}
      {...over}
    />,
  );
}

/** The gear's dot, whatever colour it is wearing. */
function gearDot(container: HTMLElement) {
  return container.querySelector("button[title^='Settings'] span");
}

describe("HeaderNav update badge", () => {
  it("shows no dot when there is nothing to install", () => {
    const { container } = renderNav({});
    expect(gearDot(container)).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("marks an ordinary update in the accent colour", () => {
    const { container } = renderNav({ updateAvailable: true });
    expect(gearDot(container)).toHaveClass("bg-accent-500");
    expect(
      screen.getByRole("button", { name: "Settings, update available" }),
    ).toBeInTheDocument();
  });

  it("marks a critical update in danger, like the event log's error badge", () => {
    // A security or data-loss fix must not look like a nice-to-have, and the
    // colour is not the only carrier — the accessible name says it too.
    const { container } = renderNav({
      updateAvailable: true,
      updateSeverity: "critical",
    });
    const dot = gearDot(container);
    expect(dot).toHaveClass("bg-danger-500");
    expect(dot).not.toHaveClass("bg-accent-500");
    expect(
      screen.getByRole("button", { name: "Settings, critical update available" }),
    ).toBeInTheDocument();
  });

  it("marks an important update in warning, between the other two", () => {
    // Worth noticing, but nothing is at risk while it waits — so not the red
    // the event log keeps for errors, and not the accent of an ordinary update.
    const { container } = renderNav({
      updateAvailable: true,
      updateSeverity: "important",
    });
    const dot = gearDot(container);
    expect(dot).toHaveClass("bg-warning-500");
    expect(dot).not.toHaveClass("bg-danger-500");
    expect(
      screen.getByRole("button", { name: "Settings, important update available" }),
    ).toBeInTheDocument();
  });

  it("says nothing about severity when no update is waiting", () => {
    // A stale severity from a previous check must not colour a dot that is not
    // there, nor rename the button.
    const { container } = renderNav({ updateSeverity: "critical" });
    expect(gearDot(container)).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("HeaderNav · the event log badge", () => {
  /** The dot on the log button, whatever colour it currently is. */
  function dot(container: HTMLElement) {
    return container.querySelector(
      '[aria-label="Event log"] span, button[title*="log" i] span',
    );
  }

  it("says nothing when everything has been read", () => {
    const { container } = renderNav({ eventBadge: null });
    expect(dot(container)).toBeNull();
  });

  it("gives an ordinary message the accent, not silence", () => {
    // An export writes a file outside the library and had no way of saying so
    // while `info` was ignored.
    const { container } = renderNav({ eventBadge: "info" });
    expect(dot(container)).toHaveClass("bg-accent-500");
  });

  it("keeps warning and error in their own colours", () => {
    // The dot has room for one answer; the colour is how it says which.
    expect(dot(renderNav({ eventBadge: "warn" }).container)).toHaveClass(
      "bg-warning-500",
    );
    expect(dot(renderNav({ eventBadge: "error" }).container)).toHaveClass(
      "bg-danger-500",
    );
  });
});
