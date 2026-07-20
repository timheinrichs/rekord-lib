import { useEffect, useRef, useState } from "react";
import { coverThumbnail } from "../lib/api";

/** Module-wide cache: path → data URL (or null = no cover). */
const cache = new Map<string, string | null>();

interface Props {
  path: string;
  hasCover: boolean;
}

/**
 * Shows a track's embedded cover as a small thumbnail.
 * Loads only once the row scrolls into the viewport (IntersectionObserver),
 * and caches the result module-wide to avoid flooding the backend.
 */
export default function CoverThumb({ path, hasCover }: Props) {
  const [url, setUrl] = useState<string | null>(() => cache.get(path) ?? null);
  const [visible, setVisible] = useState(() => cache.has(path));
  const ref = useRef<HTMLDivElement>(null);

  // Observe visibility (only load what is actually shown).
  useEffect(() => {
    if (cache.has(path) || !hasCover) return;
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

  // Load the thumbnail once visible.
  useEffect(() => {
    if (!visible || !hasCover) return;
    if (cache.has(path)) {
      setUrl(cache.get(path) ?? null);
      return;
    }
    let active = true;
    coverThumbnail(path)
      .then((u) => {
        cache.set(path, u);
        if (active) setUrl(u);
      })
      .catch(() => {
        cache.set(path, null);
      });
    return () => {
      active = false;
    };
  }, [visible, path, hasCover]);

  return (
    <div
      ref={ref}
      className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-2"
    >
      {url ? (
        <img src={url} className="h-full w-full object-cover" alt="" />
      ) : (
        <MusicIcon />
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
