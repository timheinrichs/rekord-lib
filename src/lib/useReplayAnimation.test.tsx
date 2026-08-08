import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { useReplayAnimation } from "./useReplayAnimation";

function Box({ signature }: { signature: string }) {
  const ref = useReplayAnimation<HTMLDivElement>(signature);
  return <div ref={ref} className="animate-fade-in" data-testid="box" />;
}

describe("useReplayAnimation", () => {
  it("leaves the class in place on the first render", () => {
    const { getByTestId } = render(<Box signature="a" />);
    expect(getByTestId("box")).toHaveClass("animate-fade-in");
  });

  it("still has the class after a signature change", () => {
    const { getByTestId, rerender } = render(<Box signature="a" />);
    rerender(<Box signature="b" />);
    expect(getByTestId("box")).toHaveClass("animate-fade-in");
  });

  it("re-adds the class rather than leaving it removed", () => {
    const { getByTestId, rerender } = render(<Box signature="a" />);
    const el = getByTestId("box");
    // Simulate the class having been dropped by something else; a signature
    // change must restore it.
    el.classList.remove("animate-fade-in");
    rerender(<Box signature="b" />);
    expect(el).toHaveClass("animate-fade-in");
  });

  it("does nothing when the signature is unchanged", () => {
    const { getByTestId, rerender } = render(<Box signature="a" />);
    const el = getByTestId("box");
    el.classList.remove("animate-fade-in");
    rerender(<Box signature="a" />);
    // Untouched, because the signature did not move.
    expect(el).not.toHaveClass("animate-fade-in");
  });

  it("accepts a custom class name", () => {
    function Custom({ signature }: { signature: string }) {
      const ref = useReplayAnimation<HTMLDivElement>(signature, "animate-eq");
      return <div ref={ref} data-testid="custom" />;
    }
    const { getByTestId, rerender } = render(<Custom signature="a" />);
    rerender(<Custom signature="b" />);
    expect(getByTestId("custom")).toHaveClass("animate-eq");
  });
});
