import { useEffect, useState } from "react";

import {
  driftsFrom,
  effectiveGrid,
  foldAnchor,
  snapToBeat,
} from "../lib/beatGrid";
import { useGridEdits } from "../lib/useGridEdits";

import { storedWaveforms } from "../lib/api";
import { detailFor } from "../lib/detailWaveforms";
import {
  formatBpm,
  formatDate,
  formatDuration,
  formatKey,
  formatSampleRate,
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
  /** False while the settings are over it: the lane stops asking for frames. */
  visible?: boolean;
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
  visible,
  metadata,
  settings,
  onSettingsChange,
}: Props) {
  const { seek, currentTime } = usePlayer();
  const wave = useTrackWaveform(track.path);
  const span = nearestSpan(settings.waveform_zoom_secs);
  const { edits: gridEdits, place, reset } = useGridEdits();

  // What a pointer on the lane does. Session state, not a setting: it is a
  // posture you take for a minute, not a preference.
  const [mode, setMode] = useState<"seek" | "grid">("seek");
  const [snap, setSnap] = useState(true);
  /** How far a running drag has carried the grid, before it is committed. */
  const [dragSecs, setDragSecs] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const stored = gridEdits[track.path];
  const settled = effectiveGrid(track, stored, metadata.bpm);
  // What is on screen while a drag runs: the same grid, moved. Committed on
  // release, so a drag writes one row rather than one per frame.
  const grid: Grid | null = settled
    ? { ...settled, anchorSecs: settled.anchorSecs + dragSecs }
    : null;

  const duration = track.audio.duration_secs ?? 0;
  // The phase was measured against one period; a hand-typed tempo is another,
  // and the beats walk away from the audio within a few bars. Said rather than
  // silently drawn — a grid one beat out looks exactly like a grid on time.
  const measuredAgainst = stored ? stored.bpm : track.metadata.bpm;
  const driftsFromEdit =
    settled != null &&
    measuredAgainst != null &&
    metadata.bpm != null &&
    driftsFrom(measuredAgainst, metadata.bpm);

  /**
   * Stores an anchor, folded into the first period the way the detector folds
   * its own phase — bar position and all, which is the half that is easy to
   * drop and impossible to see afterwards. See `foldAnchor`.
   */
  const put = (anchorSecs: number, downbeat: number) => {
    if (!settled) return;
    setError(null);
    const folded = foldAnchor(anchorSecs, settled.bpm, downbeat);
    void place(track.path, {
      offset_secs: folded.offsetSecs,
      bpm: settled.bpm,
      downbeat: folded.downbeat,
      edited_ms: Date.now(),
    })
      .then(() => setDragSecs(0))
      .catch((e: unknown) => {
        setDragSecs(0);
        setError(`The grid could not be stored: ${e}`);
      });
  };

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
          visible={visible}
          mode={mode}
          onGridDrag={setDragSecs}
          onGridDrop={() => grid && put(grid.anchorSecs, grid.downbeat)}
          onGridCancel={() => setDragSecs(0)}
          onSeek={(secs) => {
            // Snapped while seeking, so a click lands on a beat and you hear
            // the downbeat rather than the tail of the one before it. Never on
            // the way *out* — see `snapToBeat`.
            const at = snap ? snapToBeat(secs, settled) : secs;
            seek(duration ? at / duration : 0);
          }}
        />
        <p className="font-sans text-sm text-fg-subtle" role="status">
          {laneNote(wave)}
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
          {settled ? (
            <>
              <dl className="mt-3 space-y-1 text-sm">
                <Fact
                  label="First beat"
                  // Three decimals, which is what `Inizio` carries in the
                  // export: a fourth would be a digit the file cannot hold.
                  value={`${(grid?.anchorSecs ?? 0).toFixed(3)} s`}
                />
                <Fact label="Tempo" value={`${settled.bpm.toFixed(2)} BPM`} />
                <Fact
                  label={settled.source === "hand" ? "Set by hand" : "Confidence"}
                  value={
                    settled.source === "hand"
                      ? formatDate(stored?.edited_ms ?? null)
                      : beatConfidence(track)
                  }
                />
              </dl>

              <div
                role="radiogroup"
                aria-label="What a click does"
                className="mt-4 inline-flex items-center gap-1 rounded-lg border border-border-strong p-0.5"
              >
                {(["seek", "grid"] as const).map((m) => (
                  <button
                    key={m}
                    role="radio"
                    aria-checked={mode === m}
                    onClick={() => {
                      setMode(m);
                      setDragSecs(0);
                    }}
                    className={`h-9 inline-flex items-center justify-center rounded-md px-3 text-sm transition-colors ${
                      mode === m
                        ? "bg-accent-600/20 text-fg-accent"
                        : "text-fg-muted hover:text-fg"
                    }`}
                  >
                    {m === "seek" ? "Seek" : "Move grid"}
                  </button>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => put(currentTime(), settled.downbeat)}
                  className="h-9 inline-flex items-center justify-center rounded-md bg-accent-600 px-4 text-sm font-medium text-white hover:bg-accent-500"
                >
                  Set the anchor to the playhead
                </button>
                {/* One detail bin, so a nudge is always something you can see. */}
                {([-0.005, 0.005] as const).map((by) => (
                  <button
                    key={by}
                    onClick={() => put(settled.anchorSecs + by, settled.downbeat)}
                    className="h-9 inline-flex items-center justify-center rounded-md border border-border-strong px-3 text-sm text-fg-muted hover:border-accent-500 hover:text-fg-accent"
                    aria-label={`Nudge the anchor by ${by > 0 ? "+" : ""}${by * 1000} ms`}
                  >
                    {by > 0 ? "+5 ms" : "−5 ms"}
                  </button>
                ))}
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-3">
                <span className="text-sm text-fg-muted">The anchor is beat</span>
                <div
                  role="radiogroup"
                  aria-label="Which beat of the bar the anchor is"
                  className="inline-flex items-center gap-1 rounded-lg border border-border-strong p-0.5"
                >
                  {[1, 2, 3, 4].map((b) => (
                    <button
                      key={b}
                      role="radio"
                      aria-checked={settled.downbeat === b}
                      onClick={() => put(settled.anchorSecs, b)}
                      className={`h-9 w-9 inline-flex items-center justify-center rounded-md text-sm transition-colors ${
                        settled.downbeat === b
                          ? "bg-accent-600/20 text-fg-accent"
                          : "text-fg-muted hover:text-fg"
                      }`}
                    >
                      {b}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-4">
                <label className="flex items-center gap-2 text-sm text-fg-muted">
                  <input
                    type="checkbox"
                    checked={snap}
                    onChange={(e) => setSnap(e.currentTarget.checked)}
                    className="h-4 w-4 rounded border-border-strong bg-surface-2"
                  />
                  Snap a click to the nearest beat
                </label>
                <button
                  onClick={() => {
                    setError(null);
                    setDragSecs(0);
                    void reset(track.path).catch((e: unknown) =>
                      setError(`The grid could not be reset: ${e}`),
                    );
                  }}
                  disabled={settled.source !== "hand"}
                  title={
                    settled.source === "hand"
                      ? "Back to what the detector found"
                      : "Nothing has been set by hand"
                  }
                  className="h-9 inline-flex items-center justify-center rounded-md border border-border-strong px-3 text-sm text-fg-muted enabled:hover:border-accent-500 enabled:hover:text-fg-accent disabled:border-border disabled:text-fg-disabled"
                >
                  Reset to detected
                </button>
              </div>

              <p className="mt-4 font-sans text-sm text-fg-subtle">
                The anchor is the beat the grid is measured from, and which beat
                of the bar it is decides where every bar begins — the value the
                export writes as <code>Battito</code> and a player reads. In
                <em> move grid</em> the lane drags; Escape puts it back.
              </p>
              {driftsFromEdit && (
                <p className="mt-3 font-sans text-sm text-fg-warning">
                  The tempo has changed since the anchor was placed: it was set
                  against {measuredAgainst?.toFixed(2)} BPM, so the grid drifts
                  from here on. Move it again, or put the tempo back.
                </p>
              )}
              {error && (
                <p className="mt-3 font-sans text-sm text-fg-danger">{error}</p>
              )}
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

/**
 * How clearly the phase won, as the detector's own number.
 *
 * Bare, and deliberately not dressed up the way the key's confidence is: that
 * one has a percentage vocabulary because it was measured against 2180
 * Rekordbox keys and means something on its own. Nothing here has been
 * measured against anything, so a word would be an invention.
 */
function beatConfidence(track: TrackAnalysis): string {
  const value = track.beat_confidence;
  return value == null ? "—" : value.toFixed(2);
}

type WaveState = "loading" | "coarse" | "detail";

/**
 * What the line under the lane says about the picture on it.
 *
 * It reads the bins as well as the state, because "the closer look is
 * unavailable" is a claim about what *is* on screen — and a file ffmpeg cannot
 * read at all leaves the lane blank under a caption saying an overview is on it.
 */
function laneNote(wave: { state: WaveState; data: Waveform }): string {
  if (wave.state === "loading") return "Reading the file for a closer look";
  if (wave.state === "detail") return "\u00A0";
  return wave.data.peak.length
    ? "Showing the stored overview — the closer look is unavailable"
    : "This file could not be read for a waveform";
}

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
    // The *stored* overview, not `api.waveform`: that one falls through to a
    // full decode when the scan has not seen the file, which would be a second
    // decode of the same track running beside the detail one and finishing at
    // the same time. A coarse picture is worth having because it is instant; a
    // coarse picture that costs a decode is worth nothing.
    void storedWaveforms([path])
      .then((stored) => {
        const w = stored[path];
        if (!live || !w?.peak.length) return;
        // Only if the detail has not already won the race — a track whose
        // decode was cached answers before the overview does.
        setData((d) => (d.peak.length ? d : w));
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
