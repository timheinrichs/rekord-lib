import { describe, expect, it } from "vitest";
import { clampIndex } from "./player";

describe("clampIndex", () => {
  it("keeps an index within bounds", () => {
    expect(clampIndex(2, 5)).toBe(2);
    expect(clampIndex(-1, 5)).toBe(0);
    expect(clampIndex(9, 5)).toBe(4);
  });

  it("returns 0 for an empty queue", () => {
    expect(clampIndex(3, 0)).toBe(0);
    expect(clampIndex(0, 0)).toBe(0);
  });
});
