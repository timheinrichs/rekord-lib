import { describe, expect, it } from "vitest";
import {
  bootLabel,
  scanAnnouncement,
  scanButtonState,
  scanLabel,
} from "./boot";
import {
  STAGE_ANALYZING,
  STAGE_BPM,
  STAGE_BPM_KEY,
  STAGE_DUPLICATES,
  STAGE_KEY,
  type ScanProgress,
} from "../types";

function progress(over: Partial<ScanProgress> = {}): ScanProgress {
  return {
    generation: 1,
    done: 0,
    total: 0,
    running: true,
    paused: false,
    stage: STAGE_ANALYZING,
    ...over,
  };
}

describe("scanLabel while paused", () => {
  it("keeps the counters, because they say where it will continue", () => {
    expect(scanLabel(progress({ paused: true, done: 12, total: 2223 }))).toBe(
      "Paused · Analyzing 12/2223",
    );
    expect(
      scanLabel(
        progress({ paused: true, stage: STAGE_BPM, done: 40, total: 300 }),
      ),
    ).toBe("Paused · BPM 40/300");
  });

  it("stands alone where there is nothing to count", () => {
    // "Paused · Scanning…" would read as two states at once.
    expect(scanLabel(progress({ paused: true }))).toBe("Scan paused");
    expect(
      scanLabel(progress({ paused: true, stage: STAGE_DUPLICATES, total: 0 })),
    ).toBe("Scan paused");
  });

  it("says nothing about a pause that is not on", () => {
    expect(scanLabel(progress({ done: 5, total: 10 }))).toBe("Analyzing 5/10");
  });
});

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

  it("counts the duplicate phase when it has files to fingerprint", () => {
    expect(
      scanLabel(progress({ stage: STAGE_DUPLICATES, done: 40, total: 300 })),
    ).toBe("Duplicates 40/300");
  });

  it("drops the numbers for the duplicate phase when the cache is warm", () => {
    // Nothing to decode means nothing to count — the phase is then just a
    // comparison pass, and "0/0" would read as though it were stuck.
    expect(scanLabel(progress({ stage: STAGE_DUPLICATES, total: 0 }))).toBe(
      "Finding duplicates…",
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

describe("scanButtonState", () => {
  it("is idle when nothing is happening", () => {
    expect(scanButtonState(false, false)).toBe("idle");
  });

  it("confirms a finished run", () => {
    expect(scanButtonState(false, true)).toBe("finished");
  });

  it("has its own face while the run is held", () => {
    // The button *is* the pause control, so its action changes with this.
    expect(scanButtonState(true, false, true)).toBe("paused");
    expect(scanButtonState(true, true, true)).toBe("paused");
  });

  it("ignores a stale pause once no run is left to hold", () => {
    expect(scanButtonState(false, false, true)).toBe("idle");
    expect(scanButtonState(false, true, true)).toBe("finished");
  });

  it("lets a running pass win over a pending confirmation", () => {
    // This is the case that broke: a finished run queues the next pass, so both
    // were true at once. Colour and content branched separately and disagreed —
    // a green outline around a spinner.
    expect(scanButtonState(true, true)).toBe("busy");
    expect(scanButtonState(true, false)).toBe("busy");
  });
});

describe("the analysis stage in the scan label", () => {
  const at = (stage: string) => ({
    generation: 1,
    done: 412,
    total: 2223,
    running: true,
    paused: false,
    stage,
  });

  it("names both values when both are being detected", () => {
    // The pass decodes once and answers twice, so a label saying only "BPM"
    // understates what the run is doing — and what it is spending time on.
    expect(scanLabel(at(STAGE_BPM_KEY))).toBe("BPM/Key 412/2223");
  });

  it("names only what is actually missing", () => {
    // A library another program has tagged needs keys and nothing else.
    expect(scanLabel(at(STAGE_KEY))).toBe("Key 412/2223");
    expect(scanLabel(at(STAGE_BPM))).toBe("BPM 412/2223");
  });

  it("keeps the counters visible while paused", () => {
    expect(scanLabel({ ...at(STAGE_BPM_KEY), paused: true })).toBe(
      "Paused · BPM/Key 412/2223",
    );
  });
});

describe("scanAnnouncement", () => {
  const progress = (over: Partial<ScanProgress> = {}): ScanProgress =>
    ({
      running: true,
      paused: false,
      stage: STAGE_BPM,
      done: 43,
      total: 1200,
      ...over,
    }) as ScanProgress;

  it("says nothing while no scan has run", () => {
    expect(scanAnnouncement(null, false, false)).toBeNull();
  });

  it("leaves the counters out, so the stage is what changes", () => {
    // The whole point: `scanLabel` says "BPM 43/1200", and a polite live region
    // re-announcing that once a second is worse than silence.
    const a = scanAnnouncement(progress({ done: 43 }), true, false);
    const b = scanAnnouncement(progress({ done: 44 }), true, false);
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d/);
  });

  it("announces each stage in words", () => {
    expect(scanAnnouncement(progress({ stage: STAGE_BPM }), true, false)).toBe(
      "Detecting BPM",
    );
    expect(
      scanAnnouncement(progress({ stage: STAGE_DUPLICATES }), true, false),
    ).toBe("Finding duplicates");
    // The bare stage word is the one that reads badly on its own.
    expect(
      scanAnnouncement(progress({ stage: STAGE_ANALYZING }), true, false),
    ).toBe("Analyzing files");
  });

  it("says paused, and says finished", () => {
    expect(scanAnnouncement(progress({ paused: true }), true, false)).toBe(
      "Scan paused",
    );
    expect(scanAnnouncement(null, false, true)).toBe("Scan finished");
  });

  it("prefers the running stage over a stale finished flag", () => {
    // A finished run that has already queued the next pass is the case that
    // made the button's colour and content disagree once; the announcement must
    // not repeat it.
    expect(scanAnnouncement(progress(), true, true)).toBe("Detecting BPM");
  });
});
