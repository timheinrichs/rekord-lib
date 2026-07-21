import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  bandcampConnect,
  bandcampDisconnect,
  bandcampLogin,
  pickOutputDir,
} from "../lib/api";
import { checkForUpdate, installUpdate, type UpdateInfo } from "../lib/updater";
import {
  DOWNLOAD_FORMAT_LABELS,
  type DownloadFormat,
  type Settings,
} from "../lib/settings";
import {
  FORMAT_LABELS,
  NEWER_PLAYERS_ONLY,
  type BandcampAccount,
  type TargetFormat,
} from "../types";

const LICENSES_URL =
  "https://github.com/timheinrichs/rekord-lib/blob/main/THIRD_PARTY_LICENSES.md";

interface Props {
  settings: Settings;
  onSettingsChange: (patch: Partial<Settings>) => void;
  account: BandcampAccount | null;
  onAccountChange: (account: BandcampAccount | null) => void;
  update: UpdateInfo | null;
  onUpdateChange: (update: UpdateInfo | null) => void;
}

export default function SettingsView({
  settings,
  onSettingsChange,
  account,
  onAccountChange,
  update,
  onUpdateChange,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // App version + update state for the About section.
  const [version, setVersion] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [dlPct, setDlPct] = useState<number | null>(null);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => {});
  }, []);

  const checkUpdates = async () => {
    setChecking(true);
    setError(null);
    try {
      onUpdateChange(await checkForUpdate());
      setChecked(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setChecking(false);
    }
  };

  const runUpdate = async () => {
    setInstalling(true);
    setError(null);
    setDlPct(0);
    try {
      await installUpdate((downloaded, total) => {
        setDlPct(total ? Math.round((downloaded / total) * 100) : null);
      });
      // On success the app relaunches; nothing else to do here.
    } catch (e) {
      setError(`Update failed: ${e}`);
      setInstalling(false);
      setDlPct(null);
    }
  };

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
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">Bandcamp</h2>
        <p className="mt-1 text-sm text-fg-subtle">
          Connect your account to sync and download purchased music. No password
          is stored – only the login session.
        </p>

        {account ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <span className="inline-flex items-center gap-2 rounded-full bg-success-500/15 px-3 py-1 text-success-500 ring-1 ring-success-500/30">
              <span className="h-1.5 w-1.5 rounded-full bg-success-500" />
              Connected as {account.username || account.fan_id}
            </span>
            <button
              onClick={disconnect}
              className="ml-auto rounded-lg border border-border-strong px-3 py-1.5 hover:border-danger-500 hover:text-danger-500"
            >
              Disconnect
            </button>
          </div>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-surface-2 px-3 py-1 text-sm text-fg-muted ring-1 ring-border">
              <span className="h-1.5 w-1.5 rounded-full bg-fg-subtle" />
              Not connected
            </span>
            <button
              onClick={openLogin}
              className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium hover:bg-accent-500"
            >
              1 · Sign in to Bandcamp
            </button>
            <button
              onClick={connect}
              disabled={busy}
              className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium hover:bg-accent-500 disabled:opacity-50"
            >
              {busy ? "Connecting…" : "2 · Connect"}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-lg border border-danger-500/30 bg-danger-500/10 px-4 py-2 text-sm text-danger-500">
            {error}
          </div>
        )}
      </section>

      {/* Library folder */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">Library folder</h2>
        <p className="mt-1 text-sm text-fg-subtle">
          Central collection. Downloads and conversions land here, and the main
          view shows the contents of this folder.
        </p>
        <button
          onClick={chooseLibrary}
          className="mt-4 w-full truncate rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-left text-sm hover:border-accent-500"
          title={settings.library_dir ?? "Choose folder"}
        >
          {settings.library_dir ?? "Choose folder…"}
        </button>
      </section>

      {/* Default settings */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">
          Conversion defaults
        </h2>
        <p className="mt-1 text-sm text-fg-subtle">
          Used when converting and when importing into the library.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-fg-muted">Target format</span>
            <select
              value={settings.format}
              onChange={(e) =>
                onSettingsChange({ format: e.target.value as TargetFormat })
              }
              className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 outline-none focus:border-accent-500"
            >
              {(Object.keys(FORMAT_LABELS) as TargetFormat[]).map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-fg-muted">Bit depth</span>
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
              className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 outline-none focus:border-accent-500 disabled:opacity-40"
            >
              <option value={16}>16-bit (safe)</option>
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
              className="h-4 w-4 rounded border-border-strong bg-surface-2"
            />
            <span className="pb-2">Sanitize filenames</span>
          </label>
        </div>

        {newerOnly && (
          <div className="mt-4 rounded-lg border border-warning-500/30 bg-warning-500/10 px-4 py-2 text-sm text-warning-500">
            ⚠️ {settings.format.toUpperCase()} only works on newer players
            (CDJ-3000/NXS2), not on all CDJ/XDJ. Choose AIFF for maximum
            compatibility.
          </div>
        )}
      </section>

      {/* Downloads */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">Downloads</h2>
        <p className="mt-1 text-sm text-fg-subtle">
          Format requested from Bandcamp downloads. Files are kept as downloaded –
          convert them to your target format in the library when needed.
        </p>
        <label className="mt-4 flex max-w-xs flex-col gap-1 text-sm">
          <span className="text-fg-muted">Download format</span>
          <select
            value={settings.download_format}
            onChange={(e) =>
              onSettingsChange({
                download_format: e.target.value as DownloadFormat,
              })
            }
            className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 outline-none focus:border-accent-500"
          >
            {(Object.keys(DOWNLOAD_FORMAT_LABELS) as DownloadFormat[]).map((f) => (
              <option key={f} value={f}>
                {DOWNLOAD_FORMAT_LABELS[f]}
              </option>
            ))}
          </select>
        </label>
      </section>

      {/* Discogs */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">Discogs</h2>
        <p className="mt-1 text-sm text-fg-subtle">
          Consumer key/secret of your Discogs app (
          <button
            onClick={() =>
              void openUrl("https://www.discogs.com/settings/developers")
            }
            className="underline decoration-dotted underline-offset-2 hover:text-fg"
          >
            discogs.com/settings/developers
          </button>
          ) for per-field metadata suggestions. Stored locally only.
        </p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-fg-muted">Consumer key</span>
            <input
              value={settings.discogs_key ?? ""}
              onChange={(e) =>
                onSettingsChange({ discogs_key: e.target.value.trim() || null })
              }
              className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 outline-none focus:border-accent-500"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-fg-muted">Consumer secret</span>
            <input
              type="password"
              value={settings.discogs_secret ?? ""}
              onChange={(e) =>
                onSettingsChange({
                  discogs_secret: e.target.value.trim() || null,
                })
              }
              className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 outline-none focus:border-accent-500"
            />
          </label>
        </div>
      </section>

      {/* About / updates */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">About</h2>

        {update ? (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-full bg-accent-500/15 px-3 py-1 text-sm text-accent-300 ring-1 ring-accent-500/30">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />
              Update available: v{update.version}
            </span>
            <button
              onClick={runUpdate}
              disabled={installing}
              className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium hover:bg-accent-500 disabled:opacity-50"
            >
              {installing
                ? dlPct != null
                  ? `Installing… ${dlPct}%`
                  : "Installing…"
                : "Install & restart"}
            </button>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={checkUpdates}
              disabled={checking}
              className="rounded-lg border border-border-strong px-3 py-1.5 text-sm hover:border-accent-500 disabled:opacity-50"
            >
              {checking ? "Checking…" : "Check for updates"}
            </button>
            {checked && !checking && (
              <span className="text-sm text-fg-subtle">You’re up to date.</span>
            )}
          </div>
        )}

        {/* Version + license note (subtle, at the very bottom). */}
        <p className="mt-4 text-xs text-fg-subtle">
          rekord-lib · v{version || "…"} · MIT ·{" "}
          <button
            onClick={() => void openUrl(LICENSES_URL)}
            className="underline decoration-dotted underline-offset-2 hover:text-fg"
          >
            third-party licenses
          </button>
        </p>
      </section>
    </main>
  );
}
