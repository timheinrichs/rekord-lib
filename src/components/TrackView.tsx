import { useEffect, useState } from "react";

import { waveform as overviewWaveform } from "../lib/api";
import { detailFor } from "../lib/detailWaveforms";
import {
  formatBpm,
  formatDuration,
  formatKey,
  formatSampleRate,
  keyConfidenceLabel,
} from "../lib/format";
import { nearestSpan, ZOOM_SPANS, type Grid } from "../lib/gridLane";
import { usePlayer } from "../lib/player";
import type { Settings } from "../lib/settings";
import type { TrackAnalysis, TrackMetadata, Waveform } from "../types";
import GridLane from "./GridLane";
import VolumeControl from "./VolumeControl";

const EMPTY: Waveform = { peak: [], rms: [] };

interface Props {
  /** The row for the track the player is on. */
  track: TrackAnalysis;
  /** Its metadata with any pending edit applied — what the library shows. */
  metadata: TrackMetadata;
  settings: Settings;
  onSettingsChange: (patch: Partial<Settings>) => void;
}

/**
 * One track, large enough to read.
 *
 * The three tabs answer *which tracks*; this answers *this track*. It is a
 * surface rather than a dialog for the reason `Overlay`'s own comment gives —
 * a thing you edit in is the category that must not close on a stray Escape —
 * and because the player bar has to stay reachable underneath it.
 *
 * It deliberately carries **no transport and no overview**. The bar below
 * already has prev/play/next, the time readout and, as its 40 px waveform, the
 * whole track with a seek on it. Repeating all four here would be four more
 * places to look on an app that already has an open question about a crowded
 * header (`I6`).
 */
export default function TrackView({
  track,
  metadata,
  settings,
  onSettingsChange,
}: Props) {
  const { seek } = usePlayer();
  const wave = useTrackWaveform(track.path);
  const span = nearestSpan(settings.waveform_zoom_secs);

  const grid: Grid | null =
    track.beat_offset_secs != null && metadata.bpm
      ? { anchorSecs: track.beat_offset_secs, bpm: metadata.bpm, downbeat: 1 }
      : null;

  const duration = track.audio.duration_secs ?? 0;

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
      <header className="min-w-0">
        <h2 className="truncate text-sm font-medium text-fg">
          {metadata.title?.trim() || track.file_name}
        </h2>
        <p className="mt-1 truncate text-sm text-fg-muted">
          {metadata.artist?.trim() || "—"}
          {metadata.album?.trim() ? ` · ${metadata.album.trim()}` : ""}
        </p>
        <dl className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
          <Fact label="Tempo" value={formatBpm(metadata.bpm)} />
          <Fact label="Key" value={formatKey(track.key)} />
          <Fact
            label="Format"
            value={`${track.audio.container.toUpperCase()} · ${formatSampleRate(
              track.audio.sample_rate,
            )} · ${track.audio.bits_per_sample ?? "—"}-bit`}
          />
          <Fact label="Length" value={formatDuration(duration)} />
        </dl>
      </header>

      <section className="space-y-3">
        <GridLane
          data={wave.data}
          durationSecs={duration}
          grid={grid}
          spanSecs={span}
          onSeek={(secs) => seek(duration ? secs / duration : 0)}
        />
        <p className="font-sans text-sm text-fg-subtle" role="status">
          {wave.state === "loading"
            ? "Reading the file for a closer look"
            : wave.state === "coarse"
              ? "Showing the stored overview — the closer look is unavailable"
              : " "}
        </p>

        <div className="flex flex-wrap items-center justify-between gap-4">
          <div
            role="radiogroup"
            aria-label="Zoom"
            className="inline-flex items-center gap-1 rounded-lg border border-border-strong p-0.5"
          >
            {ZOOM_SPANS.map((s) => (
              <button
                key={s}
                role="radio"
                aria-checked={span === s}
                onClick={() => onSettingsChange({ waveform_zoom_secs: s })}
                className={`h-9 inline-flex items-center justify-center rounded-md px-3 text-sm transition-colors ${
                  span === s
                    ? "bg-accent-600/20 text-fg-accent"
                    : "text-fg-muted hover:text-fg"
                }`}
              >
                {s} s
              </button>
            ))}
          </div>
          <VolumeControl
            volume={settings.volume}
            onChange={(volume) => onSettingsChange({ volume })}
          />
        </div>
      </section>

      {/* One column today and two on a wide window, because the second is where
          the cue list goes. Empty rather than a placeholder card: a card
          labelled "Cues" with nothing in it is a promise, and nothing here
          makes one yet. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-surface p-5">
          <h3 className="text-sm font-medium text-fg">Beat grid</h3>
          {grid ? (
            <>
              <dl className="mt-3 space-y-1 text-sm">
                <Fact
                  label="First beat"
                  value={`${grid.anchorSecs.toFixed(3)} s`}
                />
                <Fact label="Tempo" value={`${grid.bpm.toFixed(2)} BPM`} />
                <Fact
                  label="Detected"
                  value={confidence(track.beat_confidence)}
                />
              </dl>
              <p className="mt-3 font-sans text-sm text-fg-subtle">
                The anchor is the beat the grid is measured from, and the app
                asserts it is the first of its bar. Neither can be moved by hand
                yet.
              </p>
            </>
          ) : (
            <p className="mt-3 font-sans text-sm text-fg-subtle">
              {metadata.bpm
                ? "No beat grid was found for this track — the tempo is known, the phase is not."
                : "No tempo, so no grid. A track with no clear pulse has no phase to place."}
            </p>
          )}
        </section>
      </div>
    </main>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="text-fg-subtle">{label}</dt>
      <dd className="text-fg">{value}</dd>
    </div>
  );
}

function confidence(value: number | null | undefined): string {
  const label = keyConfidenceLabel(value);
  return label ? `${value?.toFixed(2)} (${label})` : "—";
}

type WaveState = "loading" | "coarse" | "detail";

/**
 * The bins for the lane: the stored overview at once, the detail array when it
 * arrives.
 *
 * Never a blank rectangle. The overview is 2400 bins for the whole track — at
 * a sixteen-second window that is about a hundred across the lane, which is
 * coarse and correct — and the grid lines and the playhead are already exact on
 * top of it, because they come from numbers rather than from the picture. The
 * detail array replaces it in place when the decode finishes, with no layout
 * change and nothing to flash.
 *
 * A failed detail decode keeps the coarse picture and says so, rather than
 * clearing the lane: a file that is busy for a moment is not a file with no
 * waveform, and an empty lane would look like a broken track.
 */
function useTrackWaveform(path: string): { data: Waveform; state: WaveState } {
  const [data, setData] = useState<Waveform>(EMPTY);
  const [state, setState] = useState<WaveState>("loading");

  useEffect(() => {
    let live = true;
    setData(EMPTY);
    setState("loading");
    void overviewWaveform(path)
      .then((w) => {
        // Only if the detail has not already won the race — a track whose
        // decode was cached answers before the overview does.
        if (live && w.peak.length) setData((d) => (d.peak.length ? d : w));
      })
      .catch(() => {});
    void detailFor(path)
      .then((w) => {
        if (!live) return;
        setData(w);
        setState("detail");
      })
      .catch(() => {
        if (!live) return;
        setState((s) => (s === "detail" ? s : "coarse"));
      });
    return () => {
      live = false;
    };
  }, [path]);

  return { data, state };
}
