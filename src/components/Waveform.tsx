import { useEffect, useRef } from "react";
import { accent } from "../styles/theme";
import type { Waveform as WaveformData } from "../types";

/** Rows of pixels the waveform is drawn into, in CSS pixels. */
const HEIGHT = 40;

interface Props {
  data: WaveformData;
  /** How far through the track playback is, 0..1. */
  progress: number;
  /** Seek to a fraction of the track. */
  onSeek: (fraction: number) => void;
}

/**
 * The played/unplayed halves of the two-tone waveform.
 *
 * The peak is the outline and the RMS the core, and the core is the brighter of
 * the two — that inversion is what makes the shape readable rather than a solid
 * block. Taken from the tokens rather than written as hex: `theme.ts` exists for
 * canvas drawing, which cannot use Tailwind classes.
 */
function colours(el: HTMLElement) {
  const css = getComputedStyle(el);
  const token = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  return {
    playedPeak: accent[800],
    playedRms: accent[500],
    peak: token("--border-strong", "#343440"),
    rms: token("--fg-subtle", "#8C8C98"),
  };
}

/**
 * Draws `data` into `canvas` at its current size.
 *
 * One column per device pixel, taking the loudest bin that falls into it: the
 * bin count is fixed (2400) while the bar's width is not, so drawing one bar per
 * bin would either overdraw on a narrow window or leave gaps on a wide one.
 */
function draw(canvas: HTMLCanvasElement, data: WaveformData, progress: number) {
  const ratio = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
  const height = Math.max(1, Math.floor(HEIGHT * ratio));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx || !data.peak.length) return;

  const c = colours(canvas);
  ctx.clearRect(0, 0, width, height);
  const middle = height / 2;
  const playedUntil = Math.round(width * Math.min(Math.max(progress, 0), 1));

  for (let x = 0; x < width; x++) {
    const from = Math.floor((x * data.peak.length) / width);
    const to = Math.max(from + 1, Math.floor(((x + 1) * data.peak.length) / width));
    let peak = 0;
    let rms = 0;
    for (let i = from; i < to && i < data.peak.length; i++) {
      peak = Math.max(peak, data.peak[i]);
      rms = Math.max(rms, data.rms[i]);
    }
    const played = x < playedUntil;
    // A minimum of one pixel each way, so a quiet passage stays a line rather
    // than disappearing and looking like a gap in the file.
    const peakPx = Math.max(1, peak * middle);
    const rmsPx = Math.max(1, rms * middle);
    ctx.fillStyle = played ? c.playedPeak : c.peak;
    ctx.fillRect(x, middle - peakPx, 1, peakPx * 2);
    ctx.fillStyle = played ? c.playedRms : c.rms;
    ctx.fillRect(x, middle - rmsPx, 1, rmsPx * 2);
  }
}

/**
 * The player bar's waveform: a click seeks, and the played part is filled in.
 *
 * Keeps the slider semantics the plain progress bar had, so the control stays
 * reachable and announced rather than becoming a decorative picture.
 */
export default function Waveform({ data, progress, onSeek }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    draw(canvas, data, progress);
  }, [data, progress]);

  // Redraw on resize: the canvas' backing store is sized in device pixels, so a
  // CSS-only resize would stretch the drawing instead of re-rendering it.
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw(canvas, data, progress));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [data, progress]);

  const percent = Math.round(Math.min(Math.max(progress, 0), 1) * 100);

  return (
    <canvas
      ref={ref}
      style={{ height: HEIGHT }}
      className="w-full cursor-pointer bg-surface-2"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        onSeek((e.clientX - rect.left) / rect.width);
      }}
      role="slider"
      aria-label="Seek"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    />
  );
}
