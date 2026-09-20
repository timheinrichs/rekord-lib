import { clampVolume } from "../lib/settings";

/** The volume as the whole number the readout and the screen reader both use. */
export function volumePercent(volume: number): number {
  return Math.round(volume * 100);
}

interface Props {
  volume: number;
  onChange: (volume: number) => void;
}

/**
 * The playback level, in the two places that want it.
 *
 * One component rather than two, because the settings and the track surface are
 * setting the *same* value and a second implementation is a second place for it
 * to disagree with itself. Not in the player bar: that row is eight controls
 * wide already, and where its actions should live is an open question (`I6`).
 *
 * A range input, and deliberately not a popover with a slider in it. A panel
 * anchored in a bottom bar would have to open upward, and the Downward Menu
 * Rule says a menu opens down — a rule `menuPlacement.test.ts` enforces over the
 * source, and one that exists because an upward panel has nowhere to go.
 */
export default function VolumeControl({ volume, onChange }: Props) {
  return (
    // The readout sits outside the label: inside it, it would become part of
    // the slider's own name ("Volume 42%") and change on every step.
    <div className="flex items-center gap-3 text-sm">
      <label className="flex items-center gap-3">
        <span className="text-fg-muted">Volume</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          // What the slider says out loud is what it says on screen. The raw
          // value is `0.42`, and the readout beside it is `42%`.
          aria-valuetext={`${volumePercent(volume)}%`}
          onChange={(e) => onChange(clampVolume(e.currentTarget.valueAsNumber))}
          className="w-56 accent-accent-500"
        />
      </label>
      <span className="w-12 text-right tabular-nums text-fg">
        {volumePercent(volume)}%
      </span>
    </div>
  );
}
