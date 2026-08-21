import { describe, expect, it } from "vitest";
import { renderableNotes, severityOf, withoutSeverity } from "./changelog";

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

  it("reads the quieter level too", () => {
    expect(severityOf("**Severity:** important\n\n### Fixed\n- A thing.")).toBe(
      "important",
    );
    expect(severityOf("Severity: IMPORTANT")).toBe("important");
  });

  it("treats a word it does not know as ordinary", () => {
    // A banner nobody meant to trigger is worse than a quiet update.
    expect(severityOf("**Severity:** spicy")).toBeNull();
    // Including a near-miss of a level we do have: a typo must not invent a
    // banner, and it must not silently pick the louder neighbour either.
    expect(severityOf("**Severity:** critcal")).toBeNull();
    expect(severityOf("**Severity:** importantish")).toBeNull();
  });

  it("does not fire on the word appearing in prose", () => {
    // The marker is a line of its own; a bullet that happens to discuss
    // severity is not a declaration.
    expect(
      severityOf("- **Fixed.** Reduced the severity: critical paths are safe."),
    ).toBeNull();
  });
});

describe("withoutSeverity", () => {
  it("takes the marker line out, and only that", () => {
    expect(
      withoutSeverity("**Severity:** critical\n\n### Fixed\n- A thing."),
    ).toBe("### Fixed\n- A thing.");
  });

  it("removes a marker it does not recognise as a level too", () => {
    // It was still meant as a marker, and `**Severity:** critcal` on screen is
    // noise either way.
    expect(withoutSeverity("**Severity:** critcal\n\n- A thing.")).toBe(
      "- A thing.",
    );
  });

  it("leaves an ordinary release untouched", () => {
    expect(withoutSeverity("### Fixed\n- A thing.")).toBe("### Fixed\n- A thing.");
    expect(withoutSeverity("")).toBe("");
  });

  it("leaves the word alone where it appears in prose", () => {
    const notes = "- **Fixed.** Reduced the severity: critical paths are safe.";
    expect(withoutSeverity(notes)).toBe(notes);
  });

  it("keeps a sentence that merely opens with the word", () => {
    // The marker is a line and nothing else. A line of prose starting with it
    // is content, and deleting content is worse than showing one odd line.
    const notes = "Severity is not graded here.\n\n### Fixed\n- x";
    expect(withoutSeverity(notes)).toBe(notes);
    expect(severityOf(notes)).toBeNull();
  });
});

describe("renderableNotes", () => {
  it("is the notes without the marker", () => {
    expect(renderableNotes("**Severity:** critical\n\n- A thing.")).toBe(
      "- A thing.",
    );
  });

  it("is null when nothing is left, and when there was nothing", () => {
    // A section that is only a marker has notes and nothing to show — the
    // difference between "came without notes" and an empty framed box.
    expect(renderableNotes("**Severity:** critical")).toBeNull();
    expect(renderableNotes("   \n\n")).toBeNull();
    expect(renderableNotes(undefined)).toBeNull();
    expect(renderableNotes(null)).toBeNull();
  });
});
