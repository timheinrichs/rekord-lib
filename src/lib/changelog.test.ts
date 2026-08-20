import { describe, expect, it } from "vitest";
import { severityOf } from "./changelog";

describe("severityOf", () => {
  it("reads the marker as the changelog writes it", () => {
    expect(severityOf("**Severity:** critical\n\n### Fixed\n- A thing.")).toBe(
      "critical",
    );
  });

  it("does not care about case or emphasis", () => {
    expect(severityOf("**Severity:** CRITICAL")).toBe("critical");
    expect(severityOf("Severity: critical")).toBe("critical");
  });

  it("is null for an ordinary release", () => {
    expect(severityOf("### Fixed\n- A thing.")).toBeNull();
    expect(severityOf("")).toBeNull();
    expect(severityOf(undefined)).toBeNull();
    expect(severityOf(null)).toBeNull();
  });

  it("treats a word it does not know as ordinary", () => {
    // A banner nobody meant to trigger is worse than a quiet update.
    expect(severityOf("**Severity:** spicy")).toBeNull();
  });

  it("does not fire on the word appearing in prose", () => {
    // The marker is a line of its own; a bullet that happens to discuss
    // severity is not a declaration.
    expect(
      severityOf("- **Fixed.** Reduced the severity: critical paths are safe."),
    ).toBeNull();
  });
});
