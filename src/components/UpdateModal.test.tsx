import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { UpdateInfo } from "../lib/updater";

const mocks = vi.hoisted(() => ({
  openUrl: vi.fn(),
  installUpdate: vi.fn(
    async (_onProgress?: (downloaded: number, total: number | null) => void) => {},
  ),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: mocks.openUrl }));
vi.mock("../lib/updater", () => ({ installUpdate: mocks.installUpdate }));

const { default: UpdateModal } = await import("./UpdateModal");

function update(over: Partial<UpdateInfo> = {}): UpdateInfo {
  return {
    version: "0.7.0",
    currentVersion: "0.6.0",
    notes: "### Fixed\n- A data-loss bug.",
    severity: null,
    ...over,
  };
}

describe("UpdateModal", () => {
  it("names both versions and shows what changed", () => {
    render(<UpdateModal update={update()} onClose={() => {}} />);
    expect(screen.getByText("Update available")).toBeInTheDocument();
    expect(screen.getByText("v0.6.0 → v0.7.0")).toBeInTheDocument();
    expect(screen.getByText(/A data-loss bug/)).toBeInTheDocument();
  });

  it("says so when the release carried no notes", () => {
    // Every release built before the workflow started passing them.
    render(<UpdateModal update={update({ notes: undefined })} onClose={() => {}} />);
    expect(screen.getByText(/came without notes/)).toBeInTheDocument();
  });

  it("states a critical release in danger, and only then", () => {
    const { rerender } = render(
      <UpdateModal update={update()} onClose={() => {}} />,
    );
    expect(screen.getByText("Update available")).not.toHaveClass(
      "text-danger-500",
    );
    expect(screen.queryByText(/security or data-loss/)).toBeNull();

    rerender(
      <UpdateModal update={update({ severity: "critical" })} onClose={() => {}} />,
    );
    expect(screen.getByText("Critical update available")).toHaveClass(
      "text-danger-500",
    );
    expect(screen.getByText(/security or data-loss/)).toBeInTheDocument();
  });

  it("closes from the close icon and from Cancel", async () => {
    const onClose = vi.fn();
    render(<UpdateModal update={update()} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("opens the release for this version, not the latest one", async () => {
    render(<UpdateModal update={update()} onClose={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "View on GitHub" }));
    expect(mocks.openUrl).toHaveBeenCalledWith(
      "https://github.com/timheinrichs/rekord-lib/releases/tag/v0.7.0",
    );
  });

  it("reports progress while installing and locks the way out", async () => {
    // Closing mid-download would leave a half-applied update behind, and the
    // app relaunches on success anyway.
    mocks.installUpdate.mockImplementationOnce(async (onProgress) => {
      onProgress?.(50, 100);
      await new Promise(() => {});
    });
    const onClose = vi.fn();
    render(<UpdateModal update={update()} onClose={onClose} />);

    await userEvent.click(screen.getByRole("button", { name: "Update" }));

    expect(await screen.findByText("Updating… 50%")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });

  it("stays open with the reason when the install fails", async () => {
    mocks.installUpdate.mockRejectedValueOnce(new Error("network gone"));
    render(<UpdateModal update={update()} onClose={() => {}} />);

    await userEvent.click(screen.getByRole("button", { name: "Update" }));

    expect(await screen.findByText(/network gone/)).toBeInTheDocument();
    // And it can be tried again rather than only dismissed.
    expect(screen.getByRole("button", { name: "Update" })).toBeEnabled();
  });
});
