import { useEffect, useRef, useState } from "react";
import { coverThumbnail } from "../lib/api";
import { createCoverCache } from "../lib/coverCache";
import { PauseIcon, PlayIcon } from "./icons";

/**
 * One cache for the whole table, created once. Module scope rather than a
 * context, for the same reason as the waveform batcher: every row wants the
 * same thing from the same place.
 */
const covers = createCoverCache(coverThumbnail);

/**
 * Called for the files a write, an undo, a conversion or the scan just changed,
 * so their rows show the new artwork instead of the one from before.
 */
export function forgetCoverThumbs(paths: string[]) {
  covers.forget(paths);
}

interface Props {
  path: string;
  hasCover: boolean;
  /** When set, hovering the cover reveals a play button that calls this. */
  onPlay?: () => void;
  /** This cover represents the current player source. */
  active?: boolean;
  /** The player is currently playing (only meaningful when active). */
  playing?: boolean;
  /** Pause/resume the active item (used instead of onPlay when active). */
  onToggle?: () => void;
}

/**
 * Shows a track's embedded cover as a small thumbnail.
 * Loads only once the row scrolls into the viewport (IntersectionObserver),
 * and caches the result module-wide to avoid flooding the backend.
 */
export default function CoverThumb({
  path,
  hasCover,
  onPlay,
  active,
  playing,
  onToggle,
}: Props) {
  const [visible, setVisible] = useState(() => covers.get(path) !== undefined);
  // A counter rather than the value: the cache owns the answer, this only needs
  // to know it changed — including when it changes to a *different* cover after
  // a write, which is what the old local copy could not see.
  const [, bump] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  // Observe visibility (only load what is actually shown).
  useEffect(() => {
    if (covers.get(path) !== undefined || !hasCover) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [path, hasCover]);

  // Ask once visible, and stay subscribed: the answer can change under us.
  useEffect(() => {
    if (!visible || !hasCover) return;
    return covers.request(path, () => bump((n) => n + 1));
  }, [visible, path, hasCover]);

  const url = covers.get(path) ?? null;

  // Something is on its way: pulse rather than show the empty-cover icon, which
  // would otherwise flicker in just before the artwork replaces it.
  const pending = hasCover && !url;

  return (
    <div
      ref={ref}
      className={`group/cover relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-2 ${
        pending ? "animate-skeleton" : ""
      }`}
    >
      {url ? (
        <img
          src={url}
          className="animate-fade-in h-full w-full object-cover"
          alt=""
        />
      ) : (
        !pending && <MusicIcon />
      )}
      {onPlay && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (active) onToggle?.();
            else onPlay();
          }}
          className="absolute inset-0 flex items-center justify-center bg-black/50 text-fg opacity-0 transition-opacity group-hover/cover:opacity-100 focus:opacity-100"
          title={active && playing ? "Pause" : "Play"}
          aria-label={active && playing ? "Pause" : "Play"}
        >
          {active && playing ? <PauseIcon size={18} /> : <PlayIcon size={18} />}
        </button>
      )}
    </div>
  );
}

function MusicIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-fg-subtle"
      aria-hidden="true"
    >
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}
