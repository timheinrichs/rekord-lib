import { describe, expect, it } from "vitest";
import { bootLabel, scanLabel } from "./boot";
import { STAGE_ANALYZING, STAGE_BPM, type ScanProgress } from "../types";

function progress(over: Partial<ScanProgress> = {}): ScanProgress {
  return {
    generation: 1,
    done: 0,
    total: 0,
    running: true,
    stage: STAGE_ANALYZING,
    ...over,
  };
}

describe("scanLabel", () => {
  it("falls back to a generic label without progress", () => {
    expect(scanLabel()).toBe("Scanning…");
    expect(scanLabel(null)).toBe("Scanning…");
  });

  it("counts the probing pass once a total is known", () => {
    expect(scanLabel(progress({ done: 12, total: 2223 }))).toBe(
      "Analyzing 12/2223",
    );
  });

  it("stays generic while the total is still unknown", () => {
    expect(scanLabel(progress({ done: 0, total: 0 }))).toBe("Scanning…");
  });

  it("reports the BPM pass by name", () => {
    expect(
      scanLabel(progress({ stage: STAGE_BPM, done: 412, total: 2223 })),
    ).toBe("BPM 412/2223");
  });

  it("reports the BPM pass even before its total is set", () => {
    expect(scanLabel(progress({ stage: STAGE_BPM, done: 0, total: 0 }))).toBe(
      "BPM 0/0",
    );
  });
});

describe("bootLabel", () => {
  it("names the early phases", () => {
    expect(bootLabel("starting")).toBe("Starting app…");
    expect(bootLabel("library")).toBe("Loading library…");
  });

  it("defers to the scan label while scanning", () => {
    expect(bootLabel("scanning", progress({ done: 5, total: 100 }))).toBe(
      "Analyzing 5/100",
    );
    expect(bootLabel("scanning")).toBe("Scanning…");
  });

  it("says nothing once ready", () => {
    expect(bootLabel("ready")).toBe("");
    expect(bootLabel("ready", progress())).toBe("");
  });
});
