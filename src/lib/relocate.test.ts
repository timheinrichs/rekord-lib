import { describe, expect, it } from "vitest";

import { relocateMessage, shouldRelocate } from "./relocate";

describe("shouldRelocate", () => {
  it("re-points an existing library at a different folder", () => {
    expect(shouldRelocate("/old", "/new")).toBe(true);
  });

  it("does not run without a library to move", () => {
    expect(shouldRelocate(null, "/new")).toBe(false);
    expect(shouldRelocate(undefined, "/new")).toBe(false);
    expect(shouldRelocate("", "/new")).toBe(false);
  });

  it("does not run when the same folder is picked again", () => {
    expect(shouldRelocate("/lib", "/lib")).toBe(false);
  });
});

describe("relocateMessage", () => {
  it("says nothing when there was nothing to re-link", () => {
    expect(relocateMessage({ moved: 0, skipped: 0 })).toBeNull();
  });

  it("counts one track in the singular", () => {
    expect(relocateMessage({ moved: 1, skipped: 0 })).toBe("1 track re-linked.");
    expect(relocateMessage({ moved: 12, skipped: 0 })).toBe(
      "12 tracks re-linked.",
    );
  });

  it("names what it could not find instead of hiding it", () => {
    const msg = relocateMessage({ moved: 8, skipped: 3 });
    expect(msg).toContain("8 tracks re-linked");
    expect(msg).toContain("3 not found");
  });

  it("still reports when nothing moved but rows were left behind", () => {
    expect(relocateMessage({ moved: 0, skipped: 5 })).toContain("5 not found");
  });
});
