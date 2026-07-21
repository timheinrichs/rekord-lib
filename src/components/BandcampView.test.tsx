import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import BandcampView from "./BandcampView";
import type { BandcampAccount, BandcampItem } from "../types";

const account: BandcampAccount = { username: "dj", fan_id: 1 };

function item(over: Partial<BandcampItem> = {}): BandcampItem {
  return {
    key: "p1",
    title: "Album A",
    band_name: "Band",
    item_type: "album",
    art_url: null,
    download_page_url: "https://dl/1",
    ...over,
  };
}

function baseProps() {
  return {
    account,
    libraryDir: "/lib",
    collection: [
      item({ key: "p1", title: "Album A" }),
      item({ key: "p2", title: "Track B", item_type: "track", download_page_url: "https://dl/2" }),
    ],
    downloads: {},
    refreshing: false,
    bulk: null,
    error: null,
    presentKeys: new Set(["p1"]),
    onRefresh: vi.fn(),
    onDownloadItem: vi.fn(),
    onDownloadAll: vi.fn(),
    onSyncLibrary: vi.fn(),
    onClearDownloads: vi.fn(),
    onNavigate: vi.fn(),
    onOpenSettings: vi.fn(),
  };
}

describe("BandcampView", () => {
  it("shows a connect hint when no account", () => {
    render(<BandcampView {...baseProps()} account={null} />);
    expect(screen.getByText("Bandcamp not connected")).toBeInTheDocument();
  });

  it("lists the collection with an in-library marker", () => {
    render(<BandcampView {...baseProps()} />);
    expect(screen.getByText("Album A")).toBeInTheDocument();
    expect(screen.getByText("Track B")).toBeInTheDocument();
    // Only the present item (p1) is marked as in the library.
    expect(screen.getAllByText("In library")).toHaveLength(1);
  });

  it("triggers per-item, download-all and sync actions", async () => {
    const p = baseProps();
    render(<BandcampView {...p} />);

    await userEvent.click(screen.getAllByRole("button", { name: "Download" })[0]);
    expect(p.onDownloadItem).toHaveBeenCalledWith(p.collection[0]);

    await userEvent.click(screen.getByRole("button", { name: "Download all" }));
    expect(p.onDownloadAll).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: /Sync library/ }));
    expect(p.onSyncLibrary).toHaveBeenCalledTimes(1);
  });
});
