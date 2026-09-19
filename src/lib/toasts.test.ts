import { describe, expect, it } from "vitest";
import {
  dismissToast,
  MAX_TOASTS,
  pushToast,
  toastFor,
  type Toast,
} from "./toasts";
import type { EventNotice } from "../types";

const notice = (over: Partial<EventNotice> = {}): EventNotice => ({
  id: 1,
  level: "info",
  message: "Moved 3 tracks to the trash",
  announce: true,
  ...over,
});

const toast = (id: number): Toast => ({ id, level: "info", message: `#${id}` });

describe("toastFor", () => {
  it("shows an action's own answer", () => {
    expect(toastFor(notice())).toEqual({
      id: 1,
      level: "info",
      message: "Moved 3 tracks to the trash",
    });
  });

  it("stays quiet for what the log collects per file", () => {
    // The rule, written as the case it is for: a scan over two hundred tracks
    // writes one of these per skipped file. Two hundred messages is a wall.
    expect(
      toastFor(
        notice({
          id: 42,
          level: "warn",
          message: "Skipped b.aiff: no audio stream",
          announce: false,
        }),
      ),
    ).toBeNull();
  });

  it("does not decide by level", () => {
    // A partly failed delete is a `warn` and must be shown; a skipped file is a
    // `warn` and must not. The level cannot carry this, which is why the flag
    // comes from the backend.
    expect(toastFor(notice({ level: "warn" }))).not.toBeNull();
  });
});

describe("the stack", () => {
  it("keeps the newest few, oldest first out", () => {
    const stack = [1, 2, 3, 4].reduce<Toast[]>(
      (s, id) => pushToast(s, toast(id)),
      [],
    );
    expect(stack).toHaveLength(MAX_TOASTS);
    expect(stack.map((t) => t.id)).toEqual([2, 3, 4]);
  });

  it("replaces a notice delivered twice rather than doubling it", () => {
    // Ids come from the database, so the same one twice is a re-delivery.
    const stack = pushToast(pushToast([], toast(7)), toast(7));
    expect(stack).toHaveLength(1);
  });

  it("puts the newest last, which is the order it is drawn in", () => {
    expect(pushToast([toast(1)], toast(2)).map((t) => t.id)).toEqual([1, 2]);
  });

  it("dismisses one, and shrugs at one that is already gone", () => {
    const stack = [toast(1), toast(2)];
    expect(dismissToast(stack, 1).map((t) => t.id)).toEqual([2]);
    expect(dismissToast(stack, 99)).toHaveLength(2);
  });
});
