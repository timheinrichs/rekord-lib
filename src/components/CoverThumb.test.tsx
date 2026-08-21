import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({ coverThumbnail: vi.fn() }));
vi.mock("../lib/api", () => ({ coverThumbnail: mocks.coverThumbnail }));

// jsdom has no IntersectionObserver, and every row here is "on screen".
class Observer {
  constructor(private cb: IntersectionObserverCallback) {}
  observe() {
    this.cb(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
  disconnect() {}
  unobserve() {}
}
vi.stubGlobal("IntersectionObserver", Observer);

const { default: CoverThumb, forgetCoverThumbs } = await import("./CoverThumb");

const PATH = "/library/a.aiff";

describe("CoverThumb", () => {
  it("shows the artwork it was given", async () => {
    mocks.coverThumbnail.mockResolvedValue("data:image/jpeg;base64,OLD");
    render(<CoverThumb path={PATH} hasCover />);

    await waitFor(() =>
      expect(screen.getByRole("presentation", { hidden: true })).toHaveAttribute(
        "src",
        "data:image/jpeg;base64,OLD",
      ),
    );
  });

  it("shows the new artwork after the file was written, without remounting", async () => {
    // C7: the row stays mounted through a write, so nothing about it re-asks on
    // its own. Before the cache could be invalidated, this kept the old image
    // until the app was restarted.
    mocks.coverThumbnail.mockResolvedValue("data:image/jpeg;base64,OLD");
    const path = "/library/written.aiff";
    render(<CoverThumb path={path} hasCover />);
    const img = () => screen.getByRole("presentation", { hidden: true });
    await waitFor(() => expect(img()).toHaveAttribute("src", expect.stringContaining("OLD")));

    mocks.coverThumbnail.mockResolvedValue("data:image/jpeg;base64,NEW");
    forgetCoverThumbs([path]);

    await waitFor(() =>
      expect(img()).toHaveAttribute("src", "data:image/jpeg;base64,NEW"),
    );
  });

  it("drops the artwork when the write removed it", async () => {
    mocks.coverThumbnail.mockResolvedValue("data:image/jpeg;base64,OLD");
    const path = "/library/stripped.aiff";
    const { rerender } = render(<CoverThumb path={path} hasCover />);
    await waitFor(() =>
      expect(screen.getByRole("presentation", { hidden: true })).toBeInTheDocument(),
    );

    // The re-analyzed row says there is no cover any more, and the cache is
    // told to forget what it had.
    mocks.coverThumbnail.mockResolvedValue(null);
    forgetCoverThumbs([path]);
    rerender(<CoverThumb path={path} hasCover={false} />);

    await waitFor(() =>
      expect(screen.queryByRole("presentation", { hidden: true })).toBeNull(),
    );
  });

  it("asks the backend once for a track two rows show", async () => {
    mocks.coverThumbnail.mockClear();
    mocks.coverThumbnail.mockResolvedValue("data:image/jpeg;base64,ONE");
    const path = "/library/shared.aiff";
    render(
      <>
        <CoverThumb path={path} hasCover />
        <CoverThumb path={path} hasCover />
      </>,
    );

    await waitFor(() =>
      expect(screen.getAllByRole("presentation", { hidden: true })).toHaveLength(2),
    );
    expect(mocks.coverThumbnail).toHaveBeenCalledTimes(1);
  });
});
