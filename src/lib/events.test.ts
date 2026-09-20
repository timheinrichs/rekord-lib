import { describe, expect, it } from "vitest";

import { badgeLevel, eventsAsText, unreadCount } from "./events";
import type { AppEvent, EventLevel } from "../types";

function event(
  id: number,
  level: EventLevel,
  over: Partial<AppEvent> = {},
): AppEvent {
  return {
    id,
    created_ms: Date.UTC(2026, 7, 19, 12, 0, 0),
    level,
    source: "scan",
    message: "something happened",
    detail: null,
    ...over,
  };
}

describe("badgeLevel", () => {
  it("stays quiet when everything has been read", () => {
    const events = [event(2, "error"), event(1, "warn")];
    expect(badgeLevel(events, 2)).toBeNull();
  });

  it("does not light up for a message that was already shown", () => {
    // `info` is an action's own answer, and since 0.10.0 those are shown when
    // they happen. Counting them here lit the dot permanently about messages
    // the user had already read, and a hint that is always on distinguishes
    // nothing. The rule this replaces is in `badgeLevel`'s docstring, with
    // what the change costs.
    expect(badgeLevel([event(3, "info"), event(2, "info")], 0)).toBeNull();
  });

  it("lets the loudest unread level win", () => {
    const mixed = [event(3, "info"), event(2, "warn"), event(1, "error")];
    expect(badgeLevel(mixed, 0)).toBe("error");
    expect(badgeLevel([event(2, "info"), event(1, "warn")], 0)).toBe("warn");
  });

  it("reports a warning, and lets an error outrank it", () => {
    expect(badgeLevel([event(1, "warn")], 0)).toBe("warn");
    expect(badgeLevel([event(2, "warn"), event(1, "error")], 0)).toBe("error");
  });

  it("only counts what is newer than the marker", () => {
    const events = [event(3, "warn"), event(2, "error"), event(1, "warn")];
    // The error and the older warning are both read; the newest warning is not.
    expect(badgeLevel(events, 2)).toBe("warn");
    expect(badgeLevel(events, 3)).toBeNull();
    expect(badgeLevel(events, 1)).toBe("error");
  });

  it("still counts an unread problem that arrived after a confirmation", () => {
    // The case the change must not break: a scan warning is the reason the dot
    // exists, and a stream of confirmations after it must not bury it.
    const events = [event(4, "info"), event(3, "warn"), event(2, "info")];
    expect(badgeLevel(events, 1)).toBe("warn");
  });

  it("treats an empty log as nothing to report", () => {
    expect(badgeLevel([], 0)).toBeNull();
  });
});

describe("unreadCount", () => {
  it("counts every entry newer than the marker, whatever its level", () => {
    const events = [event(3, "info"), event(2, "error"), event(1, "warn")];
    expect(unreadCount(events, 0)).toBe(3);
    expect(unreadCount(events, 2)).toBe(1);
    expect(unreadCount(events, 3)).toBe(0);
  });
});

describe("eventsAsText", () => {
  it("renders one line per entry, detail last", () => {
    const text = eventsAsText([
      event(2, "error", { message: "Could not store 3 tracks", detail: "disk full" }),
      event(1, "info", { message: "Scan finished" }),
    ]);
    expect(text.split("\n")).toEqual([
      "2026-08-19T12:00:00.000Z [error] scan: Could not store 3 tracks — disk full",
      "2026-08-19T12:00:00.000Z [info] scan: Scan finished",
    ]);
  });

  it("is empty for an empty log", () => {
    expect(eventsAsText([])).toBe("");
  });
});
