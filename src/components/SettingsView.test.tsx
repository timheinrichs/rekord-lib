import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DEFAULT_SETTINGS } from "../lib/settings";
import type { UpdateInfo } from "../lib/updater";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "0.6.1" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../lib/api", () => ({
  bandcampConnect: vi.fn(),
  bandcampDisconnect: vi.fn(),
  bandcampLogin: vi.fn(),
  pickOutputDir: vi.fn(),
  onScanProgress: vi.fn(async () => () => {}),
}));
vi.mock("../lib/library", () => ({ relocateLibrary: vi.fn() }));
vi.mock("../lib/updater", () => ({
  checkForUpdate: vi.fn(async () => null),
  installUpdate: vi.fn(),
}));

const { default: SettingsView } = await import("./SettingsView");

function update(over: Partial<UpdateInfo>): UpdateInfo {
  return {
    version: "0.6.2",
    currentVersion: "0.6.1",
    notes: undefined,
    severity: null,
    ...over,
  };
}

function renderSettings(pending: UpdateInfo | null) {
  return render(
    <SettingsView
      settings={DEFAULT_SETTINGS}
      onSettingsChange={() => {}}
      account={null}
      onAccountChange={() => {}}
      update={pending}
      onUpdateChange={() => {}}
    />,
  );
}

describe("SettingsView · About", () => {
  it("offers a check when nothing is waiting", () => {
    renderSettings(null);
    expect(
      screen.getByRole("button", { name: "Check for updates" }),
    ).toBeInTheDocument();
  });

  it("keeps an ordinary update quiet", () => {
    const { container } = renderSettings(update({}));
    expect(screen.getByText(/Update available: v0\.6\.2/)).toBeInTheDocument();
    // The pill, not a banner: nothing in the section wears a status colour.
    expect(container.querySelector(".border-danger-500\\/40")).toBeNull();
  });

  it("keeps an important update a pill, but a yellow one", () => {
    // Loud enough to notice, quiet enough not to take the banner: nothing is at
    // risk while it waits.
    const { container } = renderSettings(update({ severity: "important" }));
    expect(
      screen.getByText(/Important update available/),
    ).toBeInTheDocument();
    expect(container.querySelector(".border-danger-500\\/40")).toBeNull();
    expect(container.querySelector(".text-warning-500")).not.toBeNull();
  });

  it("states a critical update as a banner, in danger", () => {
    // A security or data-loss fix has to look different from a nice-to-have,
    // in the same shape the library view states a broken sidecar.
    const { container } = renderSettings(update({ severity: "critical" }));
    const banner = container.querySelector(".border-danger-500\\/40");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Critical update available");
    expect(banner?.textContent).toContain("v0.6.2");
    // Still one accent for the action itself.
    expect(banner?.querySelector("button")).toHaveClass("bg-accent-600");
  });

  it("shows what changed, whatever the severity", () => {
    // The notes are the changelog section for that version — deciding whether
    // to restart now is easier when you can see what you get.
    renderSettings(update({ notes: "### Fixed\n- A data-loss bug." }));
    expect(screen.getByText(/A data-loss bug/)).toBeInTheDocument();
  });

  it("shows no notes block when the release carried none", () => {
    // Every release built before the workflow started passing them.
    const { container } = renderSettings(update({ notes: undefined }));
    // The notes themselves — not there at all rather than there and empty.
    expect(container.querySelector("[data-release-notes]")).toBeNull();
  });
});
