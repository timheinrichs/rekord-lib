import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import Overlay from "./Overlay";

describe("Overlay", () => {
  it("renders into document.body, not into its parent", () => {
    // This is the whole point: `position: fixed` resolves against the nearest
    // ancestor with a containing block, and the view wrapper's fade animation
    // touches `transform`. Staying in the tree put the modal in the middle of
    // the document instead of the screen.
    const { container } = render(
      <Overlay>
        <p>Panel</p>
      </Overlay>,
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.getByText("Panel")).toBeInTheDocument();
    expect(document.body).toContainElement(screen.getByText("Panel"));
  });

  it("wraps the content in a viewport-anchored backdrop", () => {
    render(
      <Overlay>
        <p>Panel</p>
      </Overlay>,
    );
    const backdrop = screen.getByText("Panel").parentElement;
    expect(backdrop).toHaveClass("fixed", "inset-0");
  });

  it("unmounts cleanly, leaving nothing behind in the body", () => {
    const { unmount } = render(
      <Overlay>
        <p>Panel</p>
      </Overlay>,
    );
    unmount();
    expect(screen.queryByText("Panel")).not.toBeInTheDocument();
  });

  it("closes on Escape, but only when asked to", async () => {
    // Opt-in, because the two metadata editors hold unsaved typing and a
    // keystroke aimed at a field must not take the form with it.
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Overlay onClose={onClose}>
        <p>Panel</p>
      </Overlay>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is harmless with no onClose", async () => {
    const user = userEvent.setup();
    render(
      <Overlay>
        <p>Panel</p>
      </Overlay>,
    );
    await user.keyboard("{Escape}");
    expect(screen.getByText("Panel")).toBeInTheDocument();
  });

  it("gives Escape to the topmost overlay only", async () => {
    // No pair in the app listens twice today, so this is the guard rather than
    // a reproduction: without a stack both listeners fire and one keystroke
    // collapses two dialogs, and the day a second listening overlay is opened
    // over the first, nobody would think to check.
    const user = userEvent.setup();
    const outer = vi.fn();
    const inner = vi.fn();
    const { rerender } = render(
      <>
        <Overlay onClose={outer}>
          <p>Outer</p>
        </Overlay>
        <Overlay onClose={inner}>
          <p>Inner</p>
        </Overlay>
      </>,
    );

    await user.keyboard("{Escape}");
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();

    // The inner one is gone; the next Escape reaches the one below it.
    rerender(
      <>
        <Overlay onClose={outer}>
          <p>Outer</p>
        </Overlay>
      </>,
    );
    await user.keyboard("{Escape}");
    expect(outer).toHaveBeenCalledTimes(1);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it("stops listening once it is gone", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { unmount } = render(
      <Overlay onClose={onClose}>
        <p>Panel</p>
      </Overlay>,
    );
    unmount();
    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
  });
});
