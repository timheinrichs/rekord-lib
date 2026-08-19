import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
});
