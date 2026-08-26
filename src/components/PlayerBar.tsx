import { useEffect, useMemo, useState } from "react";
import { subtitleParts, usePlayer, usePlayerProgress } from "../lib/player";
import { coverThumbnail, waveform as fetchWaveform } from "../lib/api";
import { createWaveformCache } from "../lib/waveformCache";
import Waveform from "./Waveform";
import type { Waveform as WaveformData } from "../types";
import { formatDuration } from "../lib/format";
import {
  CloseIcon,
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
} from "./icons";

/** Bottom bar that shows the current track and transport controls. */
export default function PlayerBar() {
  const {
    current,
    playing,
    hasNext,
    hasPrev,
    index,
    total,
    positioned,
    toggle,
    next,
    prev,
    close,
    seek,
  } = usePlayer();
  const { time, duration } = usePlayerProgress();
  const [cover, setCover] = useState<string | null>(null);
  const [wave, setWave] = useState<WaveformData | null>(null);
  // One cache for the life of the bar: skipping back to a track played a moment
  // ago should not decode it again.
  const waveCache = useMemo(() => createWaveformCache(), []);

  // Load the current track's embedded cover for the bar.
  useEffect(() => {
    if (!current) return;
    let active = true;
    setCover(null);
    coverThumbnail(current.path)
      .then((u) => active && setCover(u))
      .catch(() => active && setCover(null));
    return () => {
      active = false;
    };
  }, [current?.path]);

  // The waveform costs a full decode, so it arrives after playback has already
  // started. Until then the bar falls back to the plain progress line — a player
  // without a seek control would be worse than one without a picture.
  useEffect(() => {
    if (!current) return;
    let active = true;
    setWave(null);
    waveCache
      .get(current.path, fetchWaveform)
      .then((w) => active && w.peak.length > 0 && setWave(w))
      .catch((e) => {
        // A file that cannot be decoded keeps the plain bar — the player itself
        // will have failed loudly if the audio is unplayable. Still logged: a
        // silent catch here would hide a broken command permanently, since the
        // fallback looks exactly like the old, working UI.
        console.warn(`No waveform for ${current.path}:`, e);
      });
    return () => {
      active = false;
    };
  }, [current?.path, waveCache]);

  if (!current) return null;

  const pct = duration > 0 ? (time / duration) * 100 : 0;
  const subtitle = subtitleParts(current);

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-surface/95 backdrop-blur">
      {/* Seek: the waveform once it has been computed, a plain line until then */}
      {wave ? (
        <Waveform
          data={wave}
          progress={duration > 0 ? time / duration : 0}
          onSeek={seek}
        />
      ) : (
        <div
          className="group h-1.5 w-full cursor-pointer bg-surface-2"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            seek((e.clientX - r.left) / r.width);
          }}
          role="slider"
          aria-label="Seek"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-accent-500 transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <div className="flex items-center gap-4 px-6 py-3">
        {/* Cover + track info */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-2">
            {cover ? (
              <img src={cover} alt="" className="h-full w-full object-cover" />
            ) : null}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm text-fg">{current.title}</div>
            {/* Two values on one line, so one of them has to give way first
                when the window narrows. The later one does — see the
                styleguide: the album is the qualifier, the artist is the
                answer to "who is this". The huge shrink factor is what states
                that in flexbox's terms. */}
            <div className="flex min-w-0 items-baseline gap-1.5 text-xs text-fg-muted">
              <span className="min-w-0 truncate">{subtitle.artist}</span>
              {subtitle.album && (
                <>
                  <span className="shrink-0 text-fg-subtle">·</span>
                  <span className="min-w-0 shrink-[999] truncate text-fg-subtle">
                    {subtitle.album}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Transport */}
        <div className="flex items-center gap-2">
          <button
            onClick={prev}
            disabled={!hasPrev}
            className="flex h-9 w-9 items-center justify-center rounded-full text-fg-muted enabled:hover:text-fg disabled:text-fg-disabled"
            title="Previous"
            aria-label="Previous track"
          >
            <PrevIcon />
          </button>
          <button
            onClick={toggle}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-600 text-fg hover:bg-accent-500"
            title={playing ? "Pause" : "Play"}
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <PauseIcon size={20} /> : <PlayIcon size={20} />}
          </button>
          <button
            onClick={next}
            disabled={!hasNext}
            className="flex h-9 w-9 items-center justify-center rounded-full text-fg-muted enabled:hover:text-fg disabled:text-fg-disabled"
            title="Next"
            aria-label="Next track"
          >
            <NextIcon />
          </button>
        </div>

        {/* Position + time + close */}
        <div className="flex flex-1 items-center justify-end gap-4">
          {positioned && total > 1 && (
            <span className="hidden whitespace-nowrap text-xs text-fg-subtle md:inline">
              Track {index + 1}/{total}
            </span>
          )}
          <span className="hidden whitespace-nowrap text-xs text-fg-subtle sm:inline">
            {formatDuration(time)} / {formatDuration(duration)}
          </span>
          <button
            onClick={close}
            className="flex h-9 w-9 items-center justify-center rounded-full text-fg-muted hover:text-fg"
            title="Close player"
            aria-label="Close player"
          >
            <CloseIcon />
          </button>
        </div>
      </div>
    </div>
  );
}
