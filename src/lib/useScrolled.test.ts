import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useScrolled } from "./useScrolled";

afterEach(() => {
  window.scrollY = 0;
});

function scrollTo(y: number) {
  act(() => {
    window.scrollY = y;
    window.dispatchEvent(new Event("scroll"));
  });
}

describe("useScrolled", () => {
  it("is false at the top and true past the threshold", () => {
    const { result } = renderHook(() => useScrolled(100));
    expect(result.current).toBe(false);
    scrollTo(150);
    expect(result.current).toBe(true);
    scrollTo(50);
    expect(result.current).toBe(false);
  });

  it("reflects the initial scroll position on mount", () => {
    window.scrollY = 500;
    const { result } = renderHook(() => useScrolled(4));
    expect(result.current).toBe(true);
  });
});
