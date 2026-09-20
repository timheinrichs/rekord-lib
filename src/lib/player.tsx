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
  album: string;
}

/**
 * The second line of the player bar: who, and off what.
 *
 * The album is what tells two versions of the same track apart, which is the
 * question a library full of near-duplicates asks while one of them is playing.
 * It only earns its place when it is there — an empty value would be a
 * separator followed by nothing.
 */
export function subtitleParts(track: PlayerTrack): {
  artist: string;
  album: string | null;
} {
  return {
    // An em dash rather than an empty line: the row keeps its height, and a
    // missing artist reads as missing rather than as a rendering fault.
    artist: track.artist.trim() || "—",
    album: track.album.trim() || null,
  };
}

/** Clamps an index into [0, len-1] (0 for an empty queue). */
/**
 * How long a track change waits before it loads, so a burst of skips loads
 * once. See the effect that uses it for why this exists at all.
 */
export const LOAD_COALESCE_MS = 120;

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
  /** Whether the position ("Track x/y") is meaningful (e.g. an album, not the
   *  whole library) and should be shown. */
  positioned: boolean;
  play: (queue: PlayerTrack[], index: number, positioned?: boolean) => void;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  close: () => void;
  /** Seek to a fraction (0..1) of the current track. */
  seek: (fraction: number) => void;
}

/** Playback position, in its own context so ~4×/s updates don't re-render
 *  everything that only needs the stable controls (e.g. the track list). */
interface PlayerProgress {
  time: number;
  duration: number;
}

const PlayerCtx = createContext<PlayerApi | null>(null);
const ProgressCtx = createContext<PlayerProgress>({ time: 0, duration: 0 });

export function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerCtx);
  if (!ctx) throw new Error("usePlayer must be used within a PlayerProvider");
  return ctx;
}

export function usePlayerProgress(): PlayerProgress {
  return useContext(ProgressCtx);
}

/**
 * App-wide audio player. Streams local files through Tauri's asset protocol and
 * drives a single hidden <audio> element. The bottom player bar renders from
 * this context via usePlayer().
 */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  /** A track change is waiting out the coalescing window. */
  const loading = useRef(false);
  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [positioned, setPositioned] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  // Bumped on every play() so clicking a cover restarts even the same track.
  const [token, setToken] = useState(0);

  const current = queue[index] ?? null;
  const hasNext = index < queue.length - 1;
  const hasPrev = index > 0;

  const play = useCallback(
    (q: PlayerTrack[], i: number, pos = false) => {
      if (!q.length) return;
      setQueue(q);
      setIndex(clampIndex(i, q.length));
      setPositioned(pos);
      setPlaying(true);
      setToken((t) => t + 1);
    },
    [],
  );

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
  //
  // Coalesced, and not for tidiness: skipping through a queue froze the app.
  // Sampling the hung process showed the Tauri side idle in its event loop and
  // the WebKit web process blocked for good in a *synchronous* IPC —
  // `sessionCanProduceAudioChanged` → `maybeActivateAudioSession` →
  // `AudioSession::tryToSetActive` → `sendSyncMessage` → `waitForSyncReply`.
  // Every `play()` re-activates the audio session over that round trip, and
  // pressing next five times fires five of them into each other.
  //
  // So a burst of track changes loads once, at the track you land on, rather
  // than each one you pass — which is also the difference between one full
  // waveform decode and five. The delay is below what anyone notices on a
  // single skip.
  //
  // This is a mitigation, not a repair: the race is in the platform, and the
  // only lever from here is how often the session is asked to activate.
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
    loading.current = true;
    const start = setTimeout(() => {
      loading.current = false;
      a.src = convertFileSrc(currentPath);
      a.currentTime = 0;
      a.play().catch(() => setPlaying(false));
    }, LOAD_COALESCE_MS);
    return () => clearTimeout(start);
  }, [currentPath, token]);

  // Reflect play/pause state onto the element.
  //
  // Skipped while a load is pending, or this would undo the coalescing above:
  // it also depends on `currentPath`, so every track change used to reach
  // `play()` through here as well — one audio-session activation per skip,
  // which is the thing that froze the app.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !currentPath || loading.current) return;
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
      positioned,
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
      positioned,
      play,
      toggle,
      next,
      prev,
      close,
      seek,
    ],
  );

  const progress = useMemo<PlayerProgress>(
    () => ({ time, duration }),
    [time, duration],
  );

  return (
    <PlayerCtx.Provider value={api}>
      <ProgressCtx.Provider value={progress}>
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
      </ProgressCtx.Provider>
    </PlayerCtx.Provider>
  );
}
