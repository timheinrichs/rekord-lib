import { useCallback, useEffect, useMemo, useState } from "react";
import AppHeader from "./components/AppHeader";
import LibraryView from "./components/LibraryView";
import BandcampView from "./components/BandcampView";
import SettingsView from "./components/SettingsView";
import HeaderNav from "./components/HeaderNav";
import { CloseIcon } from "./components/icons";
import { bandcampStatus } from "./lib/api";
import { syncCollection } from "./lib/bandcampSync";
import { useBandcamp } from "./lib/useBandcamp";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from "./lib/settings";
import { checkForUpdate, type UpdateInfo } from "./lib/updater";
import type { BandcampAccount, TrackAnalysis } from "./types";

type MainView = "library" | "bandcamp";

export default function App() {
  const [view, setView] = useState<MainView>("library");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [account, setAccount] = useState<BandcampAccount | null>(null);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [libraryTracks, setLibraryTracks] = useState<TrackAnalysis[]>([]);

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

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next);
      return next;
    });
  }, []);

  // Which local tracks came from Bandcamp + which purchases are already local.
  const originById = useMemo(
    () => syncCollection(libraryTracks, bc.collection).originById,
    [libraryTracks, bc.collection],
  );
  const presentKeys = useMemo(
    () => new Set(Object.values(originById)),
    [originById],
  );

  const nav = (
    <HeaderNav
      view={view}
      onNavigate={setView}
      downloads={bc.downloads}
      onClearDownloads={bc.clearFinished}
      onOpenSettings={() => setSettingsOpen(true)}
      updateAvailable={!!update}
    />
  );

  return (
    <div className="min-h-screen bg-bg font-mono text-fg">
      {ready && (
        <>
          {/* Library + Bandcamp stay mounted (only hidden) so scans/downloads
              keep running when switching views or opening the settings. */}
          <div className={view !== "library" || settingsOpen ? "hidden" : undefined}>
            <LibraryView
              settings={settings}
              originById={originById}
              onTracksChange={setLibraryTracks}
              nav={nav}
              onOpenSettings={() => setSettingsOpen(true)}
            />
          </div>

          <div className={view !== "bandcamp" || settingsOpen ? "hidden" : undefined}>
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
              onNavigate={setView}
              onOpenSettings={() => setSettingsOpen(true)}
              updateAvailable={!!update}
            />
          </div>

          {settingsOpen && (
            <>
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
                account={account}
                onAccountChange={setAccount}
                update={update}
                onUpdateChange={setUpdate}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
