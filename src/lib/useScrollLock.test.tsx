import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { useScrollLock } from "./useScrollLock";

function Dialog() {
  useScrollLock();
  return <div>dialog</div>;
}

describe("useScrollLock", () => {
  it("holds the page while a dialog is mounted, and gives it back after", () => {
    const view = render(<Dialog />);
    expect(document.body.style.overflow).toBe("hidden");
    view.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("stays locked while a second dialog is still open", () => {
    // The duplicates list over the metadata editor: closing the top one must
    // not hand the scroll back to a page that is still covered.
    const first = render(<Dialog />);
    const second = render(<Dialog />);
    second.unmount();
    expect(document.body.style.overflow).toBe("hidden");
    first.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("restores whatever the page had, not a guess", () => {
    document.body.style.overflow = "scroll";
    const view = render(<Dialog />);
    expect(document.body.style.overflow).toBe("hidden");
    view.unmount();
    expect(document.body.style.overflow).toBe("scroll");
    document.body.style.overflow = "";
  });
});
