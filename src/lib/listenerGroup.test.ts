import { describe, expect, it, vi } from "vitest";
import { listenerGroup } from "./listenerGroup";

describe("listenerGroup", () => {
  it("unsubscribes everything it collected", () => {
    const group = listenerGroup();
    const a = vi.fn();
    const b = vi.fn();
    group.add(a);
    group.add(b);
    expect(a).not.toHaveBeenCalled();

    group.dispose();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes a listener that arrives after cleanup", async () => {
    // The actual leak: cleanup ran while `listen()` was still in flight, so the
    // old code never got hold of the unsubscriber at all.
    const group = listenerGroup();
    const late = vi.fn();
    const pending = Promise.resolve(late);

    group.dispose();
    group.add(await pending);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("never unsubscribes the same listener twice", () => {
    const group = listenerGroup();
    const off = vi.fn();
    group.add(off);
    group.dispose();
    group.dispose();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it("copes with nothing to unsubscribe", () => {
    const group = listenerGroup();
    expect(() => group.dispose()).not.toThrow();
  });
});
