import { act, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlayerProvider, usePlayer, type PlayerTrack } from "../lib/player";
import { REDUCED_MOTION_QUERY } from "../lib/useReducedMotion";
import type { Waveform } from "../types";
import GridLane from "./GridLane";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));

/** A ramp, so a column differs from the one beside it. */
function ramp(bins: number): Waveform {
  const peak = Array.from({ length: bins }, (_, i) => (i + 1) / bins);
  return { peak, rms: peak.map((v) => v / 2) };
}

/** Answers the reduced-motion query and nothing else. */
function motionPreference(reduce: boolean) {
  const original = window.matchMedia;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (q: string) => ({
      matches: q === REDUCED_MOTION_QUERY ? reduce : false,
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
  return () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: original,
    });
  };
}

const TRACK: PlayerTrack = {
  id: "t1",
  path: "/lib/a.aiff",
  title: "A",
  artist: "",
  album: "",
};

/** Hands the test the player's controls, so it can put it into playing state. */
let api: ReturnType<typeof usePlayer>;
function Probe() {
  api = usePlayer();
  return null;
}

function renderLane(over: Partial<Parameters<typeof GridLane>[0]> = {}) {
  return render(
    <PlayerProvider>
      <Probe />
      <GridLane
        data={ramp(2400)}
        durationSecs={240}
        grid={{ anchorSecs: 30, bpm: 128, downbeat: 1 }}
        spanSecs={16}
        onSeek={() => {}}
        {...over}
      />
    </PlayerProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("GridLane", () => {
  it("says where it is and what it can reach", () => {
    const { getByRole } = renderLane();
    const lane = getByRole("slider");
    expect(lane).toHaveAttribute("aria-valuemin", "0");
    expect(lane).toHaveAttribute("aria-valuemax", "240");
    // Named apart from the player bar's, which is on screen at the same time
    // and seeks the same track.
    expect(lane).toHaveAccessibleName("Seek, zoomed view");
  });

  it("seeks to the moment the pixel stands for", async () => {
    // jsdom measures every box as zero, so the lane has to be told how wide it
    // is before a click means anything.
    const onSeek = vi.fn();
    const { getByRole } = renderLane({ onSeek });
    const lane = getByRole("slider");
    lane.getBoundingClientRect = () =>
      ({ left: 0, width: 800, top: 0, height: 160 }) as DOMRect;

    // A quarter across a sixteen-second window centred on zero: the window runs
    // from -8 to 8, so a quarter in is -4 — before the track, which clamps to 0.
    await userEvent.click(lane);
    expect(onSeek).toHaveBeenCalled();
    expect(onSeek.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
    expect(onSeek.mock.calls[0][0]).toBeLessThanOrEqual(240);
  });

  it("survives a canvas with no 2d context", () => {
    // jsdom has none unless the `canvas` package is installed, and a released
    // build must not depend on a drawing surface existing to render a screen.
    expect(() => renderLane()).not.toThrow();
  });

  it("draws nothing rather than guessing for a track with no grid", () => {
    expect(() => renderLane({ grid: null })).not.toThrow();
  });

  it("asks for frames only while there is movement to draw", () => {
    // Paused, the last frame is already right, so a loop would be sixty wakeups
    // a second to redraw it.
    const frames = vi.spyOn(window, "requestAnimationFrame");
    renderLane();
    expect(frames).not.toHaveBeenCalled();
    act(() => api.play([TRACK], 0));
    expect(frames).toHaveBeenCalled();
  });

  it("runs no frame loop at all when the machine has asked for less motion", () => {
    // `DESIGN.md` switches every animation off under the query, and the CSS rule
    // that does it cannot reach a canvas. So the scrolling lane is not mounted:
    // not mounted, rather than mounted and idle, which is why this asserts on
    // the loop and not on the picture — and why it has to be playing to mean
    // anything.
    const restore = motionPreference(true);
    try {
      const frames = vi.spyOn(window, "requestAnimationFrame");
      renderLane();
      act(() => api.play([TRACK], 0));
      expect(frames).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
