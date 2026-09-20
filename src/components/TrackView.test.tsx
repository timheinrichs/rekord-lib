import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PlayerProvider } from "../lib/player";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { makeMetadata, makeTrack } from "../test/factories";
import type { TrackAnalysis, TrackMetadata } from "../types";
import TrackView from "./TrackView";

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (p: string) => `asset://${p}`,
}));
// The waveforms are the surface's other half and have their own tests; here the
// lane only has to mount.
vi.mock("../lib/api", () => ({ waveform: vi.fn(async () => ({ peak: [], rms: [] })) }));
vi.mock("../lib/detailWaveforms", () => ({
  detailFor: vi.fn(async () => ({ peak: [], rms: [] })),
}));

function show(track: TrackAnalysis, metadata: TrackMetadata = track.metadata) {
  return render(
    <PlayerProvider>
      <TrackView
        track={track}
        metadata={metadata}
        settings={DEFAULT_SETTINGS}
        onSettingsChange={() => {}}
      />
    </PlayerProvider>,
  );
}

const gridded = () =>
  makeTrack({
    path: "/lib/a.aiff",
    metadata: makeMetadata({ bpm: 128 }),
    beat_offset_secs: 30.25,
    beat_confidence: 0.82,
  });

describe("TrackView · the beat grid card", () => {
  it("states the anchor to the precision the export writes", () => {
    // Three decimals, because that is what `Inizio` carries. A fourth would be
    // a digit the file cannot hold.
    show(gridded());
    expect(screen.getByText("30.250 s")).toBeInTheDocument();
  });

  it("shows the detector's confidence as its own number", () => {
    // Bare, not dressed as a percentage: the key's confidence has a vocabulary
    // because it was measured against 2180 Rekordbox keys, and this one has
    // been measured against nothing.
    show(gridded());
    expect(screen.getByText("0.82")).toBeInTheDocument();
    // And not the key's percentage form. ('measured' contains 'sure', which is
    // why this asks for the shape rather than the word.)
    expect(screen.queryByText(/\d+% sure/i)).toBeNull();
  });

  it("says when a hand-typed tempo has left the anchor behind", () => {
    // The phase was measured against the detector's period. Doubling the tempo
    // by hand keeps the anchor and walks the beats off the audio within a few
    // bars — and a grid one beat out looks exactly like a grid on time.
    const track = gridded();
    show(track, makeMetadata({ bpm: 256 }));
    expect(screen.getByText(/the grid drifts from here on/i)).toBeInTheDocument();
    expect(screen.getByText(/128\.00 BPM/)).toBeInTheDocument();
  });

  it("stays quiet when the tempo is the one the anchor was measured against", () => {
    show(gridded());
    expect(screen.queryByText(/drifts from here on/i)).toBeNull();
  });

  it("says which half is missing for a track with no grid", () => {
    const track = makeTrack({
      path: "/lib/a.aiff",
      metadata: makeMetadata({ bpm: 128 }),
      beat_offset_secs: null,
    });
    show(track);
    expect(screen.getByText(/the tempo is known, the phase is not/i)).toBeInTheDocument();

    const untempoed = makeTrack({
      path: "/lib/b.aiff",
      metadata: makeMetadata({ bpm: null }),
      beat_offset_secs: null,
    });
    show(untempoed);
    expect(screen.getAllByText(/no tempo, so no grid/i).length).toBeGreaterThan(0);
  });
});
