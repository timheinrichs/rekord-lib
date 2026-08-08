import { bootLabel, type BootPhase } from "../lib/boot";
import { BuildChip } from "./AppHeader";
import type { ScanProgress } from "../types";

interface Props {
  phase: BootPhase;
  progress?: ScanProgress | null;
  /** Fading out — the app behind is ready and takes over. */
  leaving?: boolean;
}

/**
 * Full-screen start-up state. Without it the window is blank until the
 * settings load, and the library then flashes its "no music" empty state
 * while the cache is still being read.
 */
export default function AppSplash({ phase, progress, leaving }: Props) {
  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center gap-6 bg-bg ${
        leaving ? "animate-fade-out" : ""
      }`}
      role="status"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-3">
        <Mark />
        <BuildChip />
      </div>
      {/* Keyed so the text fades again whenever the phase moves on. */}
      <p
        key={phase}
        className="animate-fade-in text-xs text-fg-subtle"
      >
        {bootLabel(phase, progress)}
      </p>
    </div>
  );
}

/** x positions of the four bars in the mark, in SVG units. */
const BARS = [
  { x: 39, y: 39, h: 22 },
  { x: 51, y: 27, h: 46 },
  { x: 63, y: 33, h: 34 },
  { x: 75, y: 42, h: 16 },
];

/**
 * The logo mark, inline so the bars can move. Geometry and colours are exactly
 * those of src/assets/brand/rekord-lib-mark.svg — only the bars animate, each
 * scaling within its own shape, so the mark itself is never distorted.
 */
function Mark() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 120 100"
      width="120"
      height="100"
      fill="none"
      role="img"
      aria-label="rekord-lib"
      className="text-fg"
    >
      <path
        d="M34 20 L18 20 L18 80 L34 80"
        stroke="currentColor"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M86 20 L102 20 L102 80 L86 80"
        stroke="currentColor"
        strokeWidth="8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {BARS.map((b, i) => (
        <rect
          key={b.x}
          x={b.x}
          y={b.y}
          width="6"
          height={b.h}
          rx="3"
          className="eq-bar animate-eq fill-accent-500"
          // Staggered so the four bars read as a level meter, not as one block.
          style={{ animationDelay: `${i * 120}ms` }}
        />
      ))}
    </svg>
  );
}
