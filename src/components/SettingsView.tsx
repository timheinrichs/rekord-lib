import { useState } from "react";
import {
  bandcampConnect,
  bandcampDisconnect,
  bandcampLogin,
  pickOutputDir,
} from "../lib/api";
import type { Settings } from "../lib/settings";
import {
  FORMAT_LABELS,
  NEWER_PLAYERS_ONLY,
  type BandcampAccount,
  type TargetFormat,
} from "../types";

interface Props {
  settings: Settings;
  onSettingsChange: (patch: Partial<Settings>) => void;
  account: BandcampAccount | null;
  onAccountChange: (account: BandcampAccount | null) => void;
}

export default function SettingsView({
  settings,
  onSettingsChange,
  account,
  onAccountChange,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openLogin = async () => {
    setError(null);
    try {
      await bandcampLogin();
    } catch (e) {
      setError(String(e));
    }
  };

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      onAccountChange(await bandcampConnect());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await bandcampDisconnect().catch(() => {});
    onAccountChange(null);
  };

  const chooseLibrary = async () => {
    const dir = await pickOutputDir();
    if (dir) onSettingsChange({ library_dir: dir });
  };

  const newerOnly = NEWER_PLAYERS_ONLY.includes(settings.format);
  const pcmFormat = settings.format === "aiff" || settings.format === "wav";

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
      {/* Bandcamp */}
      <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Bandcamp</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Verbinde dein Konto, um gekaufte Musik abzugleichen und
          herunterzuladen. Es wird kein Passwort gespeichert – nur die
          Login-Sitzung.
        </p>

        {account ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-500/15 px-3 py-1 text-emerald-300 ring-1 ring-emerald-500/30">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Verbunden als {account.username || account.fan_id}
            </span>
            <button
              onClick={disconnect}
              className="ml-auto rounded-lg border border-neutral-700 px-3 py-1.5 hover:border-red-500 hover:text-red-400"
            >
              Abmelden
            </button>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-neutral-800 px-3 py-1 text-sm text-neutral-400 ring-1 ring-neutral-700">
              <span className="h-1.5 w-1.5 rounded-full bg-neutral-500" />
              Nicht verbunden
            </span>
            <button
              onClick={openLogin}
              className="rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium hover:bg-sky-500"
            >
              1 · Bei Bandcamp anmelden
            </button>
            <button
              onClick={connect}
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-50"
            >
              {busy ? "Verbinde…" : "2 · Verbindung herstellen"}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm text-red-300">
            {error}
          </div>
        )}
      </section>

      {/* Library-Ordner */}
      <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">Library-Ordner</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Zentrale Sammlung. Downloads und Konvertierungen landen hier, die
          Hauptansicht zeigt den Inhalt dieses Ordners.
        </p>
        <button
          onClick={chooseLibrary}
          className="mt-4 w-full truncate rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-left text-sm hover:border-sky-500"
          title={settings.library_dir ?? "Ordner wählen"}
        >
          {settings.library_dir ?? "Ordner wählen…"}
        </button>
      </section>

      {/* Standard-Einstellungen */}
      <section className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
        <h2 className="text-sm font-semibold text-neutral-200">
          Standard für Konvertierung
        </h2>
        <p className="mt-1 text-sm text-neutral-500">
          Wird beim Konvertieren und beim Import in die Library verwendet.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Zielformat</span>
            <select
              value={settings.format}
              onChange={(e) =>
                onSettingsChange({ format: e.target.value as TargetFormat })
              }
              className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 outline-none focus:border-sky-500"
            >
              {(Object.keys(FORMAT_LABELS) as TargetFormat[]).map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-neutral-400">Bit-Tiefe</span>
            <select
              value={settings.bit_depth}
              disabled={
                !pcmFormat &&
                settings.format !== "flac" &&
                settings.format !== "alac"
              }
              onChange={(e) =>
                onSettingsChange({ bit_depth: Number(e.target.value) })
              }
              className="rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 outline-none focus:border-sky-500 disabled:opacity-40"
            >
              <option value={16}>16-bit (sicher)</option>
              <option value={24}>24-bit</option>
            </select>
          </label>

          <label className="flex items-end gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.sanitize_filenames}
              onChange={(e) =>
                onSettingsChange({ sanitize_filenames: e.target.checked })
              }
              className="h-4 w-4 rounded border-neutral-600 bg-neutral-800"
            />
            <span className="pb-2">Dateinamen bereinigen</span>
          </label>
        </div>

        {newerOnly && (
          <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
            ⚠️ {settings.format.toUpperCase()} läuft nur auf neueren Playern
            (CDJ-3000/NXS2), nicht auf allen CDJ/XDJ. Für maximale
            Kompatibilität AIFF wählen.
          </div>
        )}
      </section>
    </main>
  );
}
