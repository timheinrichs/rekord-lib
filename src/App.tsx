import { useCallback, useEffect, useState } from "react";
import AppHeader from "./components/AppHeader";
import LibraryView from "./components/LibraryView";
import SettingsView from "./components/SettingsView";
import { bandcampStatus } from "./lib/api";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
  type Settings,
} from "./lib/settings";
import type { BandcampAccount } from "./types";

type View = "library" | "settings";

export default function App() {
  const [view, setView] = useState<View>("library");
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [account, setAccount] = useState<BandcampAccount | null>(null);
  const [ready, setReady] = useState(false);

  // Einstellungen + Bandcamp-Status beim Start laden.
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

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next);
      return next;
    });
  }, []);

  return (
    <div className="min-h-screen bg-bg font-mono text-fg">
      {ready && (
        <>
          {/* LibraryView bleibt gemountet (inkl. eigenem Header), damit laufende
              Scans/Zustände beim Öffnen der Einstellungen nicht unterbrochen oder
              neu gestartet werden – sie wird nur ausgeblendet. */}
          <div className={view === "settings" ? "hidden" : undefined}>
            <LibraryView
              settings={settings}
              account={account}
              onOpenSettings={() => setView("settings")}
            />
          </div>
          {view === "settings" && (
            <>
              <AppHeader
                onTitleClick={() => setView("library")}
                right={
                  <button
                    onClick={() => setView("library")}
                    className="shrink-0 rounded-lg border border-border-strong px-4 py-2 text-sm font-medium hover:border-accent-500"
                  >
                    Fertig
                  </button>
                }
              />
              <SettingsView
                settings={settings}
                onSettingsChange={updateSettings}
                account={account}
                onAccountChange={setAccount}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
