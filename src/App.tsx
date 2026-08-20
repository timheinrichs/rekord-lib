import { useCallback, useEffect, useMemo, useState } from "react";
import AppHeader from "./components/AppHeader";
import LibraryView from "./components/LibraryView";
import BandcampView from "./components/BandcampView";
import SettingsView from "./components/SettingsView";
import HeaderNav from "./components/HeaderNav";
import EventLogModal from "./components/EventLogModal";
import PlayerBar from "./components/PlayerBar";
import { ArrowUpIcon } from "./components/icons";
import { useScrolled } from "./lib/useScrolled";
import { PlayerProvider } from "./lib/player";
import { CloseIcon } from "./components/icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { bandcampStatus, startScan } from "./lib/api";
import { syncCollection } from "./lib/bandcampSync";
import {
  badgeLevel,
  loadEvents,
  markEventsSeen,
  onEventLogged,
} from "./lib/events";
import { useBandcamp } from "./lib/useBandcamp";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from "./lib/settings";
import { checkForUpdate, type UpdateInfo } from "./lib/updater";
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

type MainView = "library" | "bandcamp";

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
      className={`fixed bottom-6 right-6 z-40 flex h-11 w-11 items-center justify-center rounded-full border border-border-strong bg-surface text-fg shadow-lg shadow-black/40 backdrop-blur transition-all duration-300 hover:border-accent-500 hover:text-accent-400 ${
        showTop
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-4 opacity-0"
      }`}
    >
      <ArrowUpIcon />
    </button>
  );
}

export default function App() {
  const [view, setView] = useState<MainView>("library");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [account, setAccount] = useState<BandcampAccount | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [libraryTracks, setLibraryTracks] = useState<TrackAnalysis[]>([]);
  // Start-up state behind the splash. LibraryView reports the later phases,
  // since only it knows when the cache has been read.
  const [boot, setBoot] = useState<BootState>({ phase: "starting" });
  const [splashGone, setSplashGone] = useState(false);
  // The event log. Held here rather than in a view because it outlives both of
  // them and the badge sits in the shared header.
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [eventsSeen, setEventsSeen] = useState(0);
  const [logOpen, setLogOpen] = useState(false);

  const bc = useBandcamp(settings, account);

  // Load settings + Bandcamp status on startup.
  useEffect(() => {
    void (async () => {
      const [loaded, status] = await Promise.all([
        loadSettings(),
        bandcampStatus().catch(() => null),
      ]);
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
  // polling.
  useEffect(() => {
    const un = onEventLogged(refreshEvents);
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

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next);
      return next;
    });
  }, []);

  // Which local tracks came from Bandcamp + which purchases are already local.
  const sync = useMemo(
    () => syncCollection(libraryTracks, bc.collection, bc.ledger),
    [libraryTracks, bc.collection, bc.ledger],
  );
  const originById = sync.originById;
  const presentKeys = sync.presentKeys;

  // Which surface is on screen. Both main views stay mounted, so the fade is
  // replayed on the wrapper rather than by remounting.
  const surface = settingsOpen ? "settings" : view;
  const libraryFade = useReplayAnimation<HTMLDivElement>(surface);
  const bandcampFade = useReplayAnimation<HTMLDivElement>(surface);

  const nav = (
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
    <PlayerProvider>
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
              view !== "library" || settingsOpen ? "hidden" : "animate-fade-in"
            }
          >
            <LibraryView
              settings={settings}
              onSettingsChange={updateSettings}
              originById={originById}
              onTracksChange={setLibraryTracks}
              onBootPhase={handleBootPhase}
              onFilesDeleted={bc.forgetDownloads}
              nav={nav}
              onOpenSettings={() => setSettingsOpen(true)}
              onLibraryDirChange={(dir) => updateSettings({ library_dir: dir })}
            />
          </div>

          <div
            ref={bandcampFade}
            className={
              view !== "bandcamp" || settingsOpen ? "hidden" : "animate-fade-in"
            }
          >
            <BandcampView
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

          {logOpen && (
            <EventLogModal
              events={events}
              onClose={() => setLogOpen(false)}
              onCleared={refreshEvents}
            />
          )}

          {settingsOpen && (
            <div className="animate-fade-in">
              <AppHeader
                onTitleClick={() => setSettingsOpen(false)}
                right={
                  <button
                    onClick={() => setSettingsOpen(false)}
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border-strong text-fg-muted hover:border-accent-500 hover:text-accent-400"
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
      <PlayerBar />
    </PlayerProvider>
  );
}
