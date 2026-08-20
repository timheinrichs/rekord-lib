import { useEffect, useRef, useState } from "react";
import { accent, theme } from "../styles/theme";
import { storedWaveforms } from "../lib/api";
import { createWaveformBatcher } from "../lib/waveformBatch";

/** Drawing area of a row, in CSS pixels. */
const WIDTH = 112;
const HEIGHT = 26;

/**
 * One batcher for the whole table, created once.
 *
 * Module scope rather than a context: every row wants the same thing from the
 * same place, and threading a provider through the table would buy nothing that
 * a module-level instance does not already give.
 */
const batcher = createWaveformBatcher(storedWaveforms);

/** Called when a scan finishes, so rows that had no waveform ask again. */
export function forgetRowWaveforms() {
  batcher.forget();
}

/**
 * A track's waveform, drawn as the **top half** only.
 *
 * A mirrored waveform in a 26 px row gives each side 13 px; drawn from a
 * baseline the same shape gets all 26, which is the difference between seeing
 * where the breakdown is and seeing a smudge. The reference this follows does
 * the same. The RMS core sits over the peak outline, so a quiet passage still
 * reads as quiet rather than as a gap.
 */
export default function RowWaveform({ path }: { path: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // A counter rather than the value: the batcher owns the data, this only needs
  // to know that it changed.
  const [, bump] = useState(0);

  useEffect(() => {
    return batcher.request(path, () => bump((n) => n + 1));
  }, [path]);

  const data = batcher.get(path);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(WIDTH * ratio));
    const height = Math.max(1, Math.floor(HEIGHT * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx || !data.peak.length) return;

    ctx.clearRect(0, 0, width, height);
    for (let x = 0; x < width; x++) {
      // One column per device pixel, taking the loudest bin that falls into it:
      // there are 2400 bins and far fewer pixels, so drawing per bin would
      // overdraw and lose the peaks.
      const from = Math.floor((x * data.peak.length) / width);
      const to = Math.max(from + 1, Math.floor(((x + 1) * data.peak.length) / width));
      let peak = 0;
      let rms = 0;
      for (let i = from; i < to && i < data.peak.length; i++) {
        peak = Math.max(peak, data.peak[i]);
        rms = Math.max(rms, data.rms[i]);
      }
      // At least one pixel each, so silence is a line rather than a hole that
      // reads as a broken file.
      const peakPx = Math.max(1, peak * height);
      const rmsPx = Math.max(1, rms * height);
      ctx.fillStyle = theme.dark.border;
      ctx.fillRect(x, height - peakPx, 1, peakPx);
      ctx.fillStyle = accent[700];
      ctx.fillRect(x, height - rmsPx, 1, rmsPx);
    }
  }, [data]);

  // Nothing stored yet — the scan has not reached this track. An empty box of
  // the same size keeps the column from twitching as rows fill in.
  if (!data || !data.peak.length) {
    return <div style={{ width: WIDTH, height: HEIGHT }} aria-hidden="true" />;
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ width: WIDTH, height: HEIGHT }}
      aria-hidden="true"
    />
  );
}
