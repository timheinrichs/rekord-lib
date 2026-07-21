import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MarqueeText from "./MarqueeText";

describe("MarqueeText", () => {
  it("renders the given text", () => {
    // jsdom reports zero layout, so it stays in the non-overflowing state.
    render(<MarqueeText text="Some Track Title" />);
    expect(screen.getAllByText("Some Track Title").length).toBeGreaterThan(0);
  });
});
