import { useCallback, useEffect, useState } from "react";
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
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <header className="flex items-center justify-between gap-4 border-b border-neutral-800 bg-neutral-900/60 px-6 py-4">
        <button
          onClick={() => setView("library")}
          className="text-left"
          title="Zur Library"
        >
          <h1 className="text-xl font-semibold tracking-tight">
            rekord-lib
            <span className="ml-2 text-sm font-normal text-neutral-400">
              CDJ/XDJ- &amp; Rekordbox-kompatible Library
            </span>
          </h1>
        </button>

        {view === "library" ? (
          <button
            onClick={() => setView("settings")}
            className="shrink-0 rounded-lg border border-neutral-700 p-2 text-neutral-300 hover:border-sky-500 hover:text-sky-400"
            title="Einstellungen"
            aria-label="Einstellungen"
          >
            <GearIcon />
          </button>
        ) : (
          <button
            onClick={() => setView("library")}
            className="shrink-0 rounded-lg border border-neutral-700 px-4 py-2 text-sm font-medium hover:border-sky-500"
          >
            Fertig
          </button>
        )}
      </header>

      {ready && (
        <>
          {/* LibraryView bleibt gemountet, damit laufende Scans/Zustände beim
              Öffnen der Einstellungen nicht unterbrochen oder neu gestartet
              werden – sie wird nur ausgeblendet. */}
          <div className={view === "settings" ? "hidden" : undefined}>
            <LibraryView
              settings={settings}
              account={account}
              onOpenSettings={() => setView("settings")}
            />
          </div>
          {view === "settings" && (
            <SettingsView
              settings={settings}
              onSettingsChange={updateSettings}
              account={account}
              onAccountChange={setAccount}
            />
          )}
        </>
      )}
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
