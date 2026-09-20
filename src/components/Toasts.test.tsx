import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Toasts from "./Toasts";
import { TOAST_MS, type Toast } from "../lib/toasts";

const toast = (over: Partial<Toast> = {}): Toast => ({
  id: 1,
  level: "info",
  message: "Moved 3 tracks to the trash",
  ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Toasts", () => {
  it("stays out of the selector that finds a dialog", () => {
    // `appDom.overlay()` takes the last `div.fixed.inset-0.z-50`, so a toast
    // container wearing either class would be read as "the dialog on top" and
    // would break every modal assertion in `src/e2e`. Avoided by construction;
    // pinned here because the class string is the only thing holding it.
    render(<Toasts toasts={[toast()]} onExpire={() => {}} />);
    expect(document.querySelectorAll("div.fixed.inset-0.z-50")).toHaveLength(0);
  });

  it("is an announcer even with nothing to announce", () => {
    // Always mounted: a live region that arrives in the DOM together with its
    // content is not reliably announced, and this is the app's only
    // app-level one.
    render(<Toasts toasts={[]} onExpire={() => {}} />);
    const region = screen.getByRole("status", { name: "Notifications" });
    expect(region).toBeEmptyDOMElement();
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("goes away on its own, and says so once", () => {
    const onExpire = vi.fn();
    render(<Toasts toasts={[toast()]} onExpire={onExpire} />);
    expect(screen.getByText("Moved 3 tracks to the trash")).toBeInTheDocument();

    act(() => void vi.advanceTimersByTime(TOAST_MS - 1));
    expect(onExpire).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(onExpire).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("never takes a click away from what is underneath", () => {
    // Four seconds over the table it is reporting on, so it has to be
    // transparent to the pointer the whole time — there is nothing to dismiss
    // and nothing to hit.
    render(<Toasts toasts={[toast()]} onExpire={() => {}} />);
    const region = screen.getByRole("status", { name: "Notifications" });
    expect(region).toHaveClass("pointer-events-none");
    expect(region.firstElementChild).toHaveClass("pointer-events-none");
  });

  it("gives the three levels the three status hues, as a scale", () => {
    // The point is that they are one scale rather than three decisions: a run
    // that finished, one that finished partly, one that failed. The accent sat
    // in the green slot for four hours and made the good outcome the odd one
    // out, under an amber and a red that were already saying the same kind of
    // thing.
    const cases = [
      ["info", "success"],
      ["warn", "warning"],
      ["error", "danger"],
    ] as const;
    for (const [level, hue] of cases) {
      const { unmount } = render(
        <Toasts
          toasts={[toast({ level, message: `a ${level} run` })]}
          onExpire={() => {}}
        />,
      );
      const body = screen.getByText(`a ${level} run`);
      // The Tinted-Ring Rule's triple, and the theme-dependent token for the
      // text — a bare ramp hue on a tint is the defect the Two-Theme Rule names.
      expect(body.className).toContain(`bg-${hue}-500/15`);
      expect(body.className).toContain(`ring-${hue}-500/30`);
      expect(body.className).toMatch(/text-fg-(success|warning|danger)/);
      unmount();
    }
  });

  it("keeps each message on its own clock", () => {
    // One leaving must not reset another's four seconds, which is what a
    // shared timer on the container would do.
    const onExpire = vi.fn();
    const { rerender } = render(
      <Toasts toasts={[toast({ id: 1 })]} onExpire={onExpire} />,
    );
    act(() => void vi.advanceTimersByTime(TOAST_MS / 2));
    rerender(
      <Toasts
        toasts={[toast({ id: 1 }), toast({ id: 2, message: "Converted 1 track" })]}
        onExpire={onExpire}
      />,
    );

    act(() => void vi.advanceTimersByTime(TOAST_MS / 2));
    expect(onExpire).toHaveBeenCalledExactlyOnceWith(1);
    act(() => void vi.advanceTimersByTime(TOAST_MS / 2));
    expect(onExpire).toHaveBeenCalledWith(2);
  });
});
