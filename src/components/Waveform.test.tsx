import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import Waveform from "./Waveform";
import type { Waveform as WaveformData } from "../types";

/** A waveform with a recognisable shape: quiet at the start, loud at the end. */
function ramp(bins = 100): WaveformData {
  const peak = Array.from({ length: bins }, (_, i) => i / bins);
  return { peak, rms: peak.map((v) => v * 0.7) };
}

/**
 * jsdom gives every element a zero-sized box, which would make the seek maths
 * divide by zero. Real geometry is the browser's job; the arithmetic on top of
 * it is ours, and this is what makes that testable.
 */
function withWidth(width: number) {
  const canvas = screen.getByRole("slider");
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height: 40, right: width, bottom: 40, x: 0, y: 0 }) as DOMRect;
  return canvas;
}

describe("Waveform", () => {
  it("stays a slider rather than becoming a picture", () => {
    // The plain progress bar it replaces was announced and reachable; a canvas
    // that drops those semantics would quietly remove the control.
    render(<Waveform data={ramp()} progress={0.42} onSeek={() => {}} />);
    const slider = screen.getByRole("slider", { name: "Seek" });
    expect(slider.getAttribute("aria-valuenow")).toBe("42");
    expect(slider.getAttribute("aria-valuemin")).toBe("0");
    expect(slider.getAttribute("aria-valuemax")).toBe("100");
  });

  it("seeks to the fraction that was clicked", () => {
    // fireEvent rather than userEvent: the fraction comes from clientX against
    // the element's box, and only fireEvent lets a test set that coordinate.
    const onSeek = vi.fn();
    render(<Waveform data={ramp()} progress={0} onSeek={onSeek} />);
    const canvas = withWidth(1000);

    fireEvent.click(canvas, { clientX: 250 });
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek.mock.calls[0][0]).toBeCloseTo(0.25, 3);

    fireEvent.click(canvas, { clientX: 1000 });
    expect(onSeek.mock.calls[1][0]).toBeCloseTo(1, 3);
    fireEvent.click(canvas, { clientX: 0 });
    expect(onSeek.mock.calls[2][0]).toBeCloseTo(0, 3);
  });

  it("clamps the reported position instead of reporting nonsense", () => {
    // Progress arrives from the audio element, which can report a time past the
    // duration for a moment at the end of a track.
    const { rerender } = render(
      <Waveform data={ramp()} progress={1.4} onSeek={() => {}} />,
    );
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("100");
    rerender(<Waveform data={ramp()} progress={-0.2} onSeek={() => {}} />);
    expect(screen.getByRole("slider").getAttribute("aria-valuenow")).toBe("0");
  });

  it("renders without a 2d context at all", () => {
    // jsdom has none, and neither does a browser that refused the context. The
    // control has to survive that rather than throwing during render.
    expect(() =>
      render(<Waveform data={ramp()} progress={0.5} onSeek={() => {}} />),
    ).not.toThrow();
    expect(screen.getByRole("slider")).toBeTruthy();
  });

  it("renders an empty waveform without crashing", () => {
    expect(() =>
      render(<Waveform data={{ peak: [], rms: [] }} progress={0} onSeek={() => {}} />),
    ).not.toThrow();
  });
});
