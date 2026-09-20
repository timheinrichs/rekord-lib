import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppHeader from "./components/AppHeader";
import LibraryView from "./components/LibraryView";
import BandcampView from "./components/BandcampView";
import SettingsView from "./components/SettingsView";
import HeaderNav from "./components/HeaderNav";
import EventLogModal from "./components/EventLogModal";
import UpdateModal from "./components/UpdateModal";
import PlayerBar from "./components/PlayerBar";
import PlaylistsView from "./components/PlaylistsView";
import TrackView from "./components/TrackView";
import Toasts from "./components/Toasts";
import { ArrowUpIcon } from "./components/icons";
import { useScrolled } from "./lib/useScrolled";
import { PlayerProvider, usePlayer } from "./lib/player";
import { CloseIcon } from "./components/icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { bandcampStatus, startScan } from "./lib/api";
import { allowLibraryPlayback } from "./lib/library";
import { applyTheme, resolveTheme, SYSTEM_LIGHT_QUERY } from "./lib/theme";
import { syncCollection } from "./lib/bandcampSync";
import {
  badgeLevel,
  loadEvents,
  markEventsSeen,
  onEventLogged,
} from "./lib/events";
import {
  dismissToast,
  pushToast,
  toastFor,
  type Toast,
} from "./lib/toasts";
import { useBandcamp } from "./lib/useBandcamp";
import { usePlaylists } from "./lib/usePlaylists";
import type { ColumnId } from "./lib/columns";
import { metaOf, type Edits } from "./lib/grouping";
import type { MainView } from "./lib/views";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from "./lib/settings";
import {
  checkForUpdate,
  promptedUpdate,
  type UpdateInfo,
} from "./lib/updater";
import AppSplash from "./components/AppSplash";
import { useReplayAnimation } from "./lib/useReplayAnimation";
import type { BootPhase } from "./lib/boot";
import type {
  AppEvent,
  BandcampAccount,
  ScanProgress,
  TrackAnalysis,
} from "./types";

interface BootState {
  phase: BootPhase;
  progress?: ScanProgress | null;
}

/**
 * Shortest time the splash stays up. Without it a warm cache resolves within
 * a frame or two and the splash registers as a flicker — the very thing it is
 * there to prevent.
 */
const MIN_SPLASH_MS = 300;

/**
 * The shortest gap between two settings writes.
 *
 * Every save rewrites the whole of `rekord-lib.json`, which also holds the
 * Bandcamp collection — by far the largest thing in it. That was one rewrite
 * per click for as long as every control in the settings was a select, a
 * checkbox or a button. The volume slider is the first *continuous* one, and a
 * single drag of it fired a hundred rewrites at the store, none of them awaited
 * against each other — so which level actually landed on disk was a race
 * between a hundred writes of the same file.
 *
 * Leading edge, not just trailing: the first change of a burst is written
 * immediately, and only the ones behind it wait. A click therefore reaches disk
 * exactly as fast as it always did, which matters because a webview being torn
 * down by a window close does not unmount anything and cannot flush. Only the
 * tail of a drag is ever in flight, and that value is one step away from the
 * one already written.
 *
 * Coalescing the *write* rather than only committing the slider on release,
 * because the state has to stay live either way: the level reaches the player
 * through React on every step. Same idea as the player's `LOAD_COALESCE_MS`.
 */
const SAVE_COALESCE_MS = 200;

/**
 * Back to the top of the list.
 *
 * App-wide chrome, and a sibling of the view wrappers on purpose: `position:
 * fixed` resolves against the nearest ancestor that establishes a containing
 * block, and the wrappers' `animate-fade-in` touches `transform`. Inside one,
 * this button anchors to the bottom of the *document* instead of the screen —
 * the same reason the modals render through a portal (see `Overlay`).
 */
function BackToTop() {
  const showTop = useScrolled(400);
  return (
    <button
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Back to top"
      className={`fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-border-strong bg-surface text-fg shadow-lg shadow-black/40 transition-[opacity,transform,border-color,color] duration-300 hover:border-accent-500 hover:text-fg-accent ${
        showTop
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-4 opacity-0"
      }`}
    >
      <ArrowUpIcon />
    </button>
  );
}

/**
 * The track surface, and the one invariant behind it: it is always the track
 * the player is on.
 *
 * A component of its own rather than a block in `App`, because it needs
 * `usePlayer()` and `App` renders the provider — so this is the first place
 * inside it that knows which track is playing. It also means closing the player
 * closes the surface, with no second piece of state to keep in step.
 */
function TrackSurface({
  visible,
  tracks,
  edits,
  settings,
  onSettingsChange,
  onClose,
}: {
  /** False while the settings are over it — see the wrapper that renders this. */
  visible: boolean;
  tracks: TrackAnalysis[];
  edits: Edits;
  settings: Settings;
  onSettingsChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}) {
  const { current } = usePlayer();
  const track = current
    ? (tracks.find((t) => t.path === current.path) ?? null)
    : null;

  // Nothing playing, nothing to show. `close` on the bar empties the queue, and
  // a surface for a track that is no longer there would be a screen with a
  // heading and a blank.
  useEffect(() => {
    if (!current) onClose();
  }, [current, onClose]);

  return (
    <div className="animate-fade-in">
      <AppHeader
        title="Track"
        onTitleClick={onClose}
        right={
          <button
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-strong text-fg-muted hover:border-accent-500 hover:text-fg-accent"
            title="Back to the library"
            aria-label="Back to the library"
          >
            <CloseIcon />
          </button>
        }
      />
      {track ? (
        <TrackView
          track={track}
          visible={visible}
          metadata={metaOf(track, edits)}
          settings={settings}
          onSettingsChange={onSettingsChange}
        />
      ) : (
        <main className="mx-auto max-w-6xl px-6 py-8">
          <p className="font-sans text-sm text-fg-subtle">
            This track is not in the library, so there is nothing stored to show
            for it.
          </p>
        </main>
      )}
    </div>
  );
}

export default function App() {
  const [view, setView] = useState<MainView>("library");
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Whether the track surface is up. Not which track: that is always the one
  // the player is on, so closing the player closes this with it.
  const [trackOpen, setTrackOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  /**
   * The settings as they stand, so a patch can be merged outside a state
   * updater.
   *
   * The merge used to happen inside `setSettings`, and that put the write it
   * queues and the timer that flushes it in an order nothing guarantees: React
   * may defer, interrupt or replay an updater, and a flush that runs before the
   * render has happened finds nothing pending, clears its timer and writes
   * nothing at all. An updater is also required to be pure. So the merge is
   * here, synchronously, and `setSettings` is handed a value.
   */
  const settingsRef = useRef<Settings>(DEFAULT_SETTINGS);
  const [account, setAccount] = useState<BandcampAccount | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [libraryTracks, setLibraryTracks] = useState<TrackAnalysis[]>([]);
  // The pending edits, mirrored up beside the tracks: the playlists view shows
  // titles and has to show the same ones the library does.
  const [libraryEdits, setLibraryEdits] = useState<Edits>({});
  // Start-up state behind the splash. LibraryView reports the later phases,
  // since only it knows when the cache has been read.
  const [boot, setBoot] = useState<BootState>({ phase: "starting" });
  const [splashGone, setSplashGone] = useState(false);
  // The event log. Held here rather than in a view because it outlives both of
  // them and the badge sits in the shared header.
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [eventsSeen, setEventsSeen] = useState(0);
  const [logOpen, setLogOpen] = useState(false);
  // The messages on their way past. Here for the same three reasons the log is:
  // they outlive both views, the subscriber is the same one, and anything
  // floating has to be a sibling of the view wrappers rather than inside one.
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Whether the start-up update prompt has been answered. Per session, not
  // persisted: the next launch is the next chance to notice, which is the whole
  // reason the prompt exists.
  const [updatePromptSeen, setUpdatePromptSeen] = useState(false);

  const bc = useBandcamp(settings, account);
  // The playlists. Here rather than in a view because two of them read the same
  // list now, and a second `usePlaylists` would be a second copy: the hook has
  // no store and no subscription, so a write in one view would leave the other
  // showing what it last read.
  const playlists = usePlaylists();

  // Load settings + Bandcamp status on startup.
  useEffect(() => {
    void (async () => {
      const [loaded, status] = await Promise.all([
        loadSettings(),
        bandcampStatus().catch(() => null),
      ]);
      settingsRef.current = loaded;
      setSettings(loaded);
      setAccount(status);
      setReady(true);
    })();
  }, []);

  // Check for an app update on startup (silent; errors are treated as "up to date").
  useEffect(() => {
    void (async () => setUpdate(await checkForUpdate()))();
  }, []);

  // The splash may not disappear before this has elapsed (see MIN_SPLASH_MS).
  const [minSplashOver, setMinSplashOver] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setMinSplashOver(true), MIN_SPLASH_MS);
    return () => clearTimeout(id);
  }, []);

  const splashLeaving = boot.phase === "ready" && minSplashOver;

  // The update the start-up prompt should show, if any.
  const prompted = promptedUpdate(
    update,
    updatePromptSeen,
    splashGone,
    settingsOpen,
  );

  // Drop the splash once it has faded, so it stops covering the app.
  useEffect(() => {
    if (!splashLeaving) return;
    const id = setTimeout(() => setSplashGone(true), 150);
    return () => clearTimeout(id);
  }, [splashLeaving]);

  const handleBootPhase = useCallback(
    (phase: BootPhase, progress?: ScanProgress | null) =>
      setBoot((prev) =>
        prev.phase === phase && prev.progress === progress
          ? prev
          : { phase, progress },
      ),
    [],
  );

  // The settings are in; from here the library decides when it is ready.
  useEffect(() => {
    if (ready) handleBootPhase("library");
  }, [ready, handleBootPhase]);

  // Mark the window title in dev builds so the dev instance is identifiable.
  useEffect(() => {
    if (import.meta.env.DEV) {
      void getCurrentWindow()
        .setTitle("rekord-lib (dev)")
        .catch(() => {});
    }
  }, []);

  // The theme on `<html>`, kept in step with the setting *and* with the system.
  //
  // The listener is the reason this is an effect rather than a one-off at load:
  // `system` has to keep resolving, so a machine that switches to light at
  // sunset takes the app with it without a restart. `matchMedia` is guarded
  // because jsdom has it only in newer versions and a component test that never
  // touches the theme should not need it.
  useEffect(() => {
    const mq =
      typeof window.matchMedia === "function"
        ? window.matchMedia(SYSTEM_LIGHT_QUERY)
        : null;
    const paint = () => applyTheme(resolveTheme(settings.theme, mq?.matches ?? false));
    paint();
    if (!mq || settings.theme !== "system") return;
    mq.addEventListener("change", paint);
    return () => mq.removeEventListener("change", paint);
  }, [settings.theme]);

  // Re-runs tempo detection over the whole library, overwriting existing values.
  // Needed when the detector improves: tracks that already carry a BPM are
  // skipped by the normal pass, so without this an old result is permanent.
  const redetectBpm = useCallback(() => {
    const dir = settings.library_dir;
    if (!dir || !libraryTracks.length) return;
    void startScan(dir, true, libraryTracks.map((t) => t.path), true, false, {
      min: settings.bpm_min,
      max: settings.bpm_max,
    });
  }, [settings.library_dir, settings.bpm_min, settings.bpm_max, libraryTracks]);

  const refreshEvents = useCallback(() => {
    void loadEvents()
      .then((log) => {
        setEvents(log.events);
        setEventsSeen(log.seen_id);
      })
      // A log that cannot be read is not worth an error of its own — the badge
      // simply stays quiet.
      .catch(() => {});
  }, []);

  useEffect(refreshEvents, [refreshEvents]);

  // The backend says when it recorded something, so the badge follows without
  // polling — and hands over the row, so an action's own answer can be shown
  // on its way past. Boot cannot raise one: `refreshEvents` reads the log, and
  // reading does not emit.
  useEffect(() => {
    const un = onEventLogged((notice) => {
      refreshEvents();
      const toast = toastFor(notice);
      if (toast) setToasts((prev) => pushToast(prev, toast));
    });
    return () => {
      void un.then((f) => f());
    };
  }, [refreshEvents]);

  // Opening the log is what marks it read: the badge answers "is there
  // something I have not looked at", not "has anything ever gone wrong".
  const openEventLog = useCallback(() => {
    setLogOpen(true);
    const newest = events[0]?.id ?? 0;
    if (newest > eventsSeen) {
      setEventsSeen(newest);
      void markEventsSeen(newest).catch(() => {});
    }
  }, [events, eventsSeen]);

  /** The latest settings, and whether the burst they came from moved the folder. */
  const pendingSave = useRef<{ settings: Settings; grant: boolean } | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWriteAt = useRef(0);
  const writes = useRef<Promise<unknown>>(Promise.resolve());

  const flushSettings = useCallback(() => {
    if (saveTimer.current !== null) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const next = pendingSave.current;
    pendingSave.current = null;
    if (!next) return;
    lastWriteAt.current = Date.now();
    // Chained, not fired: two overlapping `save()` calls rewrite the same file,
    // and the one that finishes last wins whether or not it is the newer one.
    //
    // The scope grant reads the folder back out of the store rather than taking
    // it from here, so it has to wait for the write — before it, the backend
    // would still be looking at the previous folder. A write that failed
    // therefore must not be followed by the grant: the folder the backend would
    // read is still the old one.
    writes.current = writes.current
      .then(() => saveSettings(next.settings))
      .then(() => (next.grant ? allowLibraryPlayback() : undefined))
      .catch((e: unknown) => {
        // Caught rather than left to reject, because a rejected promise left in
        // this chain would take every later write down with it. Reported to the
        // console rather than as a toast: a toast here is a copy of an event log
        // row and the log is written by the backend, so a failure on this side
        // of the boundary has no channel of its own — the same reason
        // `PlayerBar` warns about a waveform it could not get.
        console.warn("Could not save the settings", e);
      });
  }, []);

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      const next = { ...settingsRef.current, ...patch };
      settingsRef.current = next;
      setSettings(next);
      pendingSave.current = {
        settings: next,
        grant: !!patch.library_dir || !!pendingSave.current?.grant,
      };
      // Leading edge as well as trailing: a click writes at once, the way it
      // always did, and only a *burst* waits. That keeps the quit-right-after-a
      // -click case exactly as safe as it was, and leaves at risk only the tail
      // of a drag — where the value that did reach disk is one drag-step away
      // from the one that did not.
      if (saveTimer.current !== null) return;
      const since = Date.now() - lastWriteAt.current;
      if (since >= SAVE_COALESCE_MS) {
        flushSettings();
        return;
      }
      saveTimer.current = setTimeout(flushSettings, SAVE_COALESCE_MS - since);
    },
    [flushSettings],
  );

  // Best effort for the tail of a burst. It covers a React unmount, which a
  // Tauri window close is not — that tears the webview down without unmounting
  // anything — so it is not the reason the leading-edge write above exists.
  useEffect(() => flushSettings, [flushSettings]);

  // Which local tracks came from Bandcamp + which purchases are already local.
  const sync = useMemo(
    () => syncCollection(libraryTracks, bc.collection, bc.ledger),
    [libraryTracks, bc.collection, bc.ledger],
  );
  const originById = sync.originById;
  const presentKeys = sync.presentKeys;

  // Which surface is on screen. Both main views stay mounted, so the fade is
  // replayed on the wrapper rather than by remounting.
  // Settings wins over the track surface, so there is never a second `h1` on
  // screen — `appDom` throws rather than guessing when there is.
  const surface = settingsOpen ? "settings" : trackOpen ? "track" : view;
  const libraryFade = useReplayAnimation<HTMLDivElement>(surface);
  const playlistsFade = useReplayAnimation<HTMLDivElement>(surface);
  const bandcampFade = useReplayAnimation<HTMLDivElement>(surface);

  // A function, not an element: a React element has one parent, so handing the
  // same `nav` to two mounted views would leave one of them without it.
  const renderNav = () => (
    <HeaderNav
      view={view}
      onNavigate={setView}
      downloads={bc.downloads}
      onClearDownloads={bc.clearFinished}
      onCancelDownload={bc.cancelDownload}
      onOpenSettings={() => setSettingsOpen(true)}
      updateAvailable={!!update}
      updateSeverity={update?.severity ?? null}
      eventBadge={badgeLevel(events, eventsSeen)}
      onOpenEventLog={openEventLog}
    />
  );

  return (
    <PlayerProvider volume={settings.volume}>
    <div className="min-h-screen bg-bg font-mono text-fg">
      {!splashGone && (
        <AppSplash
          phase={boot.phase}
          progress={boot.progress}
          leaving={splashLeaving}
        />
      )}
      {ready && (
        <>
          {/* Library + Bandcamp stay mounted (only hidden) so scans/downloads
              keep running when switching views or opening the settings. */}
          {/* The fade is replayed by class, never by `key`: a changed key
              would remount the view and kill a running scan. */}
          <div
            ref={libraryFade}
            className={
              surface !== "library" ? "hidden" : "animate-fade-in"
            }
          >
            <LibraryView
              settings={settings}
              playlists={playlists}
              onSettingsChange={updateSettings}
              originById={originById}
              onTracksChange={setLibraryTracks}
              onEditsChange={setLibraryEdits}
              onBootPhase={handleBootPhase}
              onFilesDeleted={bc.forgetDownloads}
              nav={renderNav()}
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenTrack={() => setTrackOpen(true)}
              onLibraryDirChange={(dir) => updateSettings({ library_dir: dir })}
            />
          </div>

          <div
            ref={playlistsFade}
            className={
              surface !== "playlists" ? "hidden" : "animate-fade-in"
            }
          >
            <PlaylistsView
              onTitleClick={() => setView("library")}
              playlists={playlists}
              tracks={libraryTracks}
              edits={libraryEdits}
              hiddenColumns={(settings.hidden_columns ?? []) as ColumnId[]}
              active={view === "playlists"}
              nav={renderNav()}
            />
          </div>

          <div
            ref={bandcampFade}
            className={
              surface !== "bandcamp" ? "hidden" : "animate-fade-in"
            }
          >
            <BandcampView
              onTitleClick={() => setView("library")}
              account={account}
              libraryDir={settings.library_dir}
              collection={bc.collection}
              downloads={bc.downloads}
              refreshing={bc.refreshing}
              bulk={bc.bulk}
              error={bc.error}
              presentKeys={presentKeys}
              onRefresh={() => void bc.refresh()}
              onDownloadItem={(item) => void bc.downloadItem(item)}
              onDownloadAll={() => void bc.downloadAll()}
              onSyncLibrary={() => void bc.syncLibrary(libraryTracks)}
              onClearDownloads={bc.clearFinished}
              onCancelDownload={bc.cancelDownload}
              onNavigate={setView}
              onOpenSettings={() => setSettingsOpen(true)}
              updateAvailable={!!update}
              updateSeverity={update?.severity ?? null}
              eventBadge={badgeLevel(events, eventsSeen)}
              onOpenEventLog={openEventLog}
            />
          </div>

          {/* Held back until the splash is gone, so the prompt lands on the
              app rather than over the launch animation. */}
          {prompted && (
            <UpdateModal
              update={prompted}
              onClose={() => setUpdatePromptSeen(true)}
            />
          )}

          {logOpen && (
            <EventLogModal
              events={events}
              onClose={() => setLogOpen(false)}
              onCleared={refreshEvents}
            />
          )}


          {/* Mounted while it is open, hidden while the settings are over it —
              the same treatment the three views get, and for a reason of its
              own: unmounting it would stop it noticing that the player was
              closed underneath, and it would come back with a heading over a
              blank. */}
          {trackOpen && (
            <div className={surface !== "track" ? "hidden" : undefined}>
              <TrackSurface
                visible={surface === "track"}
                tracks={libraryTracks}
                edits={libraryEdits}
                settings={settings}
                onSettingsChange={updateSettings}
                onClose={() => setTrackOpen(false)}
              />
            </div>
          )}
          {settingsOpen && (
            <div className="animate-fade-in">
              <AppHeader
                title="Settings"
                onTitleClick={() => setSettingsOpen(false)}
                right={
                  <button
                    onClick={() => setSettingsOpen(false)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-strong text-fg-muted hover:border-accent-500 hover:text-fg-accent"
                    title="Close settings"
                    aria-label="Close settings"
                  >
                    <CloseIcon />
                  </button>
                }
              />
              <SettingsView
                settings={settings}
                onSettingsChange={updateSettings}
                onRedetectBpm={redetectBpm}
                trackCount={libraryTracks.length}
                account={account}
                onAccountChange={setAccount}
                update={update}
                onUpdateChange={setUpdate}
              />
            </div>
          )}
        </>
      )}
    </div>
      <BackToTop />
      <Toasts
        toasts={toasts}
        onExpire={(id) => setToasts((prev) => dismissToast(prev, id))}
      />
      <PlayerBar
        onExpand={() => setTrackOpen((open) => !open)}
        expanded={trackOpen}
      />
    </PlayerProvider>
  );
}
