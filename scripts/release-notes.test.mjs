import { describe, expect, it } from "vitest";
import { sectionFor, severityIn } from "./release-notes.mjs";

/** The shapes CHANGELOG.md actually contains, in miniature. */
const CHANGELOG = `# Changelog

All notable changes to rekord-lib are documented here.

## [Unreleased]

## [0.6.1] - 2026-08-21

**Severity:** critical

### Fixed
- **A bold lead sentence.** Then an explanation that wraps
  over a second line and mentions [0.6.0] in passing.

### Changed
- Something else.

## [0.6.0] - 2026-08-20

### Added
- A feature.

## [0.3.3] - 2026-07-21

Maintenance release — confirms the pipeline. No functional changes.

### Note
Free prose, no bullets.

## [0.1.0] - 2026-07-01

- Project scaffold.

[Unreleased]: https://github.com/timheinrichs/rekord-lib/compare/v0.6.1...HEAD
[0.6.1]: https://github.com/timheinrichs/rekord-lib/compare/v0.6.0...v0.6.1
[0.3.2]: https://github.com/timheinrichs/rekord-lib/releases/tag/v0.3.2
`;

describe("sectionFor", () => {
  it("cuts out exactly one version's section", () => {
    const s = sectionFor(CHANGELOG, "0.6.0");
    expect(s).toContain("### Added");
    expect(s).toContain("- A feature.");
    // Neither neighbour leaks in.
    expect(s).not.toContain("Severity");
    expect(s).not.toContain("Maintenance release");
  });

  it("keeps the severity line, which is the point of reading it in the app", () => {
    expect(sectionFor(CHANGELOG, "0.6.1")).toContain("**Severity:** critical");
  });

  it("keeps wrapped bullet continuations together", () => {
    const s = sectionFor(CHANGELOG, "0.6.1");
    expect(s).toContain("over a second line");
  });

  it("accepts a v-prefixed tag name, which is what the workflow passes", () => {
    expect(sectionFor(CHANGELOG, "v0.6.0")).toContain("- A feature.");
  });

  it("survives prose and a non-standard section under a heading", () => {
    const s = sectionFor(CHANGELOG, "0.3.3");
    expect(s).toContain("Maintenance release");
    expect(s).toContain("### Note");
    expect(s).toContain("Free prose, no bullets.");
  });

  it("reads the last section without running into the link definitions", () => {
    // The oldest versions have no link definition of their own, and the block at
    // the bottom of the file is the file's bookkeeping, not release notes.
    const s = sectionFor(CHANGELOG, "0.1.0");
    expect(s).toBe("- Project scaffold.");
  });

  it("returns null for a version that has no section", () => {
    expect(sectionFor(CHANGELOG, "9.9.9")).toBeNull();
  });

  it("returns null for a heading with an empty body", () => {
    // `## [Unreleased]` right before the next heading — a release cut from this
    // must fail loudly rather than ship empty notes.
    expect(sectionFor(CHANGELOG, "Unreleased")).toBeNull();
  });
});

describe("severityIn", () => {
  it("finds the marker under a version heading", () => {
    expect(severityIn(sectionFor(CHANGELOG, "0.6.1"))).toBe("critical");
  });

  it("is null for an ordinary release", () => {
    expect(severityIn(sectionFor(CHANGELOG, "0.6.0"))).toBeNull();
    expect(severityIn(null)).toBeNull();
  });

  it("does not care about case", () => {
    expect(severityIn("**Severity:** CRITICAL")).toBe("critical");
  });
});
