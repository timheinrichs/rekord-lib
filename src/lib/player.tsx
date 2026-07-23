import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

/** A single entry in the play queue. */
export interface PlayerTrack {
  id: string;
  path: string;
  title: string;
  artist: string;
}

/** Clamps an index into [0, len-1] (0 for an empty queue). */
export function clampIndex(i: number, len: number): number {
  if (len <= 0) return 0;
  return Math.max(0, Math.min(i, len - 1));
}

interface PlayerApi {
  current: PlayerTrack | null;
  playing: boolean;
  hasNext: boolean;
  hasPrev: boolean;
  /** Zero-based position in the queue and its length (for "Track x/y"). */
  index: number;
  total: number;
  /** Playback position and length in seconds. */
  time: number;
  duration: number;
  play: (queue: PlayerTrack[], index: number) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  close: () => void;
  /** Seek to a fraction (0..1) of the current track. */
  seek: (fraction: number) => void;
}

const PlayerCtx = createContext<PlayerApi | null>(null);

export function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer must be used within a PlayerProvider");
  return ctx;
}

/**
 * App-wide audio player. Streams local files through Tauri's asset protocol and
 * drives a single hidden <audio> element. The bottom player bar renders from
 * this context via usePlayer().
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Bumped on every play() so clicking a cover restarts even the same track.
  const [token, setToken] = useState(0);

  const current = queue[index] ?? null;
  const hasNext = index < queue.length - 1;
  const hasPrev = index > 0;

  const play = useCallback((q: PlayerTrack[], i: number) => {
    if (!q.length) return;
    setQueue(q);
    setIndex(clampIndex(i, q.length));
    setPlaying(true);
    setToken((t) => t + 1);
  }, []);

  const next = useCallback(
    () => setIndex((i) => clampIndex(i + 1, queue.length)),
    [queue.length],
  );
  const prev = useCallback(
    () => setIndex((i) => clampIndex(i - 1, queue.length)),
    [queue.length],
  );
  const toggle = useCallback(() => setPlaying((p) => !p), []);
  const close = useCallback(() => {
    setPlaying(false);
    setQueue([]);
    setIndex(0);
  }, []);

  const seek = useCallback((fraction: number) => {
    const a = audioRef.current;
    if (!a || !a.duration) return;
    a.currentTime = Math.max(0, Math.min(1, fraction)) * a.duration;
  }, []);

  // Load and (re)start when the current track — or an explicit play() — changes.
  const currentPath = current?.path;
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    if (!currentPath) {
      a.pause();
      a.removeAttribute("src");
      setTime(0);
      setDuration(0);
      return;
    }
    a.src = convertFileSrc(currentPath);
    a.currentTime = 0;
    a.play().catch(() => setPlaying(false));
  }, [currentPath, token]);

  // Reflect play/pause state onto the element.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !currentPath) return;
    if (playing) a.play().catch(() => setPlaying(false));
    else a.pause();
  }, [playing, currentPath]);

  // Reserve space at the bottom so the fixed bar never covers content.
  const active = !!current;
  useEffect(() => {
    document.body.style.paddingBottom = active ? "5rem" : "";
    return () => {
      document.body.style.paddingBottom = "";
    };
  }, [active]);

  const api = useMemo<PlayerApi>(
    () => ({
      current,
      playing,
      hasNext,
      hasPrev,
      index,
      total: queue.length,
      time,
      duration,
      play,
      toggle,
      next,
      prev,
      close,
      seek,
    }),
    [
      current,
      playing,
      hasNext,
      hasPrev,
      index,
      queue.length,
      time,
      duration,
      play,
      toggle,
      next,
      prev,
      close,
      seek,
    ],
  );

  return (
    <PlayerCtx.Provider value={api}>
      {children}
      <audio
        ref={audioRef}
        hidden
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onEnded={() => {
          if (hasNext) next();
          else setPlaying(false);
        }}
      />
    </PlayerCtx.Provider>
  );
}
