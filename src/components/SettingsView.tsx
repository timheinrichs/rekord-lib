import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  bandcampConnect,
  bandcampDisconnect,
  bandcampLogin,
  clearDiscogsCredentials,
  discogsCredentials,
  onScanProgress,
  pickOutputDir,
  setDiscogsAppCredentials,
  setDiscogsToken,
  type DiscogsStatus,
} from "../lib/api";
import { formatDate } from "../lib/format";
import { relocateLibrary } from "../lib/library";
import { relocateMessage, shouldRelocate } from "../lib/relocate";
import { checkForUpdate, installUpdate, type UpdateInfo } from "../lib/updater";
import { renderableNotes } from "../lib/changelog";
import { HeartIcon } from "./icons";
import ReleaseNotes from "./ReleaseNotes";
import {
  BPM_RANGE_PRESETS,
  DOWNLOAD_FORMAT_LABELS,
  type DownloadFormat,
  type Settings,
} from "../lib/settings";
import {
  FORMAT_LABELS,
  NEWER_PLAYERS_ONLY,
  type BandcampAccount,
  type ScanProgress,
  type TargetFormat,
} from "../types";

const LICENSES_URL =
  "https://github.com/timheinrichs/rekord-lib/blob/main/THIRD_PARTY_LICENSES.md";
const DONATE_URL =
  "https://www.paypal.com/donate/?hosted_button_id=UJGTJEK598ZFS";

interface Props {
  settings: Settings;
  onSettingsChange: (patch: Partial<Settings>) => void;
  /** Re-runs tempo detection over the whole library, overwriting existing values. */
  onRedetectBpm?: () => void;
  /** Number of tracks the re-detect run would cover. */
  trackCount?: number;
  account: BandcampAccount | null;
  onAccountChange: (account: BandcampAccount | null) => void;
  update: UpdateInfo | null;
  onUpdateChange: (update: UpdateInfo | null) => void;
}

export default function SettingsView({
  settings,
  onSettingsChange,
  onRedetectBpm,
  trackCount = 0,
  account,
  onAccountChange,
  update,
  onUpdateChange,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Outcome of the last library re-link, shown under the folder button.
  const [relocated, setRelocated] = useState<string | null>(null);

  // The re-detect run reports itself here: it starts in the background and the
  // library table is a view away, so without this the button looks inert for
  // the minutes the pass takes.
  const [scan, setScan] = useState<ScanProgress | null>(null);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let un: (() => void) | undefined;
    void onScanProgress((p) => {
      setScan(p.running ? p : null);
      if (p.running) setStarting(false);
    }).then((f) => (un = f));
    return () => un?.();
  }, []);

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

  // The install button says the same thing in both shapes it appears in.
  const installLabel = installing
    ? dlPct != null
      ? `Installing… ${dlPct}%`
      : "Installing…"
    : "Install & restart";

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

  // Picking a different folder for an existing library means the collection
  // moved, not that it was replaced — so the stored rows are re-pointed before
  // the setting changes, and keep their edits and fingerprints.
  const chooseLibrary = async () => {
    const dir = await pickOutputDir();
    if (!dir) return;
    const previous = settings.library_dir;
    setRelocated(null);
    if (shouldRelocate(previous, dir)) {
      try {
        setRelocated(relocateMessage(await relocateLibrary(previous!, dir)));
      } catch (e) {
        // The setting still changes: a failed re-link costs the cache, not the
        // files, and refusing to move the folder would be the bigger problem.
        setError(`Could not re-link the library: ${e}`);
      }
    }
    onSettingsChange({ library_dir: dir });
  };

  // Discogs credentials. Write-only: they go into the Keychain and the app only
  // ever asks again whether one is there, and which form it took.
  const [discogs, setDiscogs] = useState<DiscogsStatus | null>(null);
  const [discogsToken, setDiscogsTokenInput] = useState("");
  const [discogsKey, setDiscogsKey] = useState("");
  const [discogsSecret, setDiscogsSecret] = useState("");
  const [showAppForm, setShowAppForm] = useState(false);
  const [discogsBusy, setDiscogsBusy] = useState(false);
  const [discogsError, setDiscogsError] = useState<string | null>(null);

  const readDiscogs = () =>
    discogsCredentials()
      .then(setDiscogs)
      // A rejected call is the same situation as a Keychain that says no.
      .catch(() =>
        setDiscogs({
          stored: false,
          unavailable: true,
          kind: null,
          saved_at: null,
        }),
      );

  useEffect(() => {
    void readDiscogs();
  }, []);

  /** Runs one Keychain write and leaves no copy of what was typed behind. */
  const storeDiscogs = async (write: () => Promise<void>) => {
    setDiscogsBusy(true);
    setDiscogsError(null);
    try {
      await write();
      setDiscogsTokenInput("");
      setDiscogsKey("");
      setDiscogsSecret("");
      await readDiscogs();
    } catch (e) {
      setDiscogsError(`Could not store the credentials: ${e}`);
    } finally {
      setDiscogsBusy(false);
    }
  };

  const forgetDiscogs = async () => {
    setDiscogsBusy(true);
    setDiscogsError(null);
    try {
      await clearDiscogsCredentials();
      setDiscogsTokenInput("");
      setDiscogsKey("");
      setDiscogsSecret("");
      setShowAppForm(false);
      await readDiscogs();
    } catch (e) {
      setDiscogsError(`Could not remove the credentials: ${e}`);
    } finally {
      setDiscogsBusy(false);
    }
  };

  // What the update's notes come to once the severity marker is out of them —
  // null both when a release carried none and when the marker was all there was.
  const updateNotes = renderableNotes(update?.notes);

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
              className="h-9 inline-flex items-center justify-center ml-auto rounded-md border border-border-strong px-3 hover:border-danger-500 hover:text-danger-500"
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
              className="h-9 inline-flex items-center justify-center rounded-md bg-accent-600 px-4 text-sm font-medium hover:bg-accent-500"
            >
              1 · Sign in to Bandcamp
            </button>
            <button
              onClick={connect}
              disabled={busy}
              className="h-9 inline-flex items-center justify-center rounded-md bg-accent-600 px-4 text-sm font-medium enabled:hover:bg-accent-500 disabled:bg-surface-2 disabled:text-fg-disabled"
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
          className="h-9 inline-flex items-center justify-center mt-4 w-full truncate rounded-md border border-border-strong bg-surface-2 px-3 text-left text-sm hover:border-accent-500"
          title={settings.library_dir ?? "Choose folder"}
        >
          {settings.library_dir ?? "Choose folder…"}
        </button>
        {relocated && (
          <p className="mt-2 text-sm text-fg-muted">{relocated}</p>
        )}
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
              className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 outline-none focus:border-accent-500 disabled:border-border disabled:text-fg-disabled"
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

      {/* Analysis */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">Analysis</h2>
        <p className="mt-1 text-sm text-fg-subtle">
          Tracks without a BPM tag are analysed during the scan, and the result
          is written into the file so it only ever happens once. Files that
          already carry a BPM keep it. Turning this off leaves the scan
          read-only.
        </p>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={settings.analyze_bpm}
            onChange={(e) => onSettingsChange({ analyze_bpm: e.target.checked })}
            className="h-4 w-4 rounded border-border-strong bg-surface-2"
          />
          <span>Detect BPM and write it into the files</span>
        </label>
        <label className="mt-4 flex flex-col gap-1 text-sm">
          <span className="text-fg-muted">Tempo range</span>
          <select
            value={`${settings.bpm_min}-${settings.bpm_max}`}
            onChange={(e) => {
              const [min, max] = e.target.value.split("-").map(Number);
              onSettingsChange({ bpm_min: min, bpm_max: max });
            }}
            className="w-64 rounded-md border border-border-strong bg-surface-2 px-2 py-1.5 text-fg outline-none focus:border-accent-500"
          >
            {BPM_RANGE_PRESETS.map((p) => (
              <option key={p.label} value={`${p.min}-${p.max}`}>
                {p.label}
              </option>
            ))}
          </select>
          <span className="font-sans text-xs text-fg-subtle">
            A range spanning one octave gives every tempo a single
            representative, which removes a class of half/double-time errors —
            worth narrowing if your library sits in one genre. Tracks that
            already carry a BPM keep it, so use "Re-detect BPM" below to apply a
            change to what is already tagged.
          </span>
        </label>
        {onRedetectBpm && (
          <div className="mt-4 border-t border-border pt-4">
            <p className="text-sm text-fg-subtle">
              Tracks that already carry a BPM are never re-analysed, so an
              earlier result stays put even after the detector improves. This
              runs detection over the whole library again and overwrites it.
            </p>
            <button
              onClick={() => {
                setStarting(true);
                onRedetectBpm();
              }}
              disabled={!trackCount || !!scan || starting}
              className="h-9 inline-flex items-center justify-center mt-3 rounded-md border border-border-strong px-3 text-sm enabled:hover:border-accent-500 disabled:border-border disabled:text-fg-disabled"
            >
              {scan
                ? scan.stage.startsWith("Detecting")
                  ? `${scan.stage} · ${scan.done}/${scan.total}`
                  : `${scan.stage}… ${scan.done}/${scan.total}`
                : starting
                  ? "Starting…"
                  : `Re-detect BPM for all ${trackCount || ""} tracks`}
            </button>
            {scan && (
              <p className="mt-2 text-sm text-fg-subtle">
                Runs in the background — you can keep using the app.
              </p>
            )}
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
        <p className="mt-1 font-sans text-sm text-fg-subtle">
          Per-field suggestions for genre, year, label and country. They work
          without an account: Discogs answers anonymous searches at 25 requests
          per minute. A personal access token from{" "}
          <button
            onClick={() =>
              void openUrl("https://www.discogs.com/settings/developers")
            }
            className="underline decoration-dotted underline-offset-2 hover:text-fg"
          >
            discogs.com/settings/developers
          </button>{" "}
          raises that to 60. It is kept in the macOS Keychain, not in the
          app&rsquo;s settings file.
        </p>

        {/* The Keychain is the only copy, so a Keychain that will not answer is
            said plainly rather than papered over with an empty form: nothing was
            lost, and entering the credential again is the way out. What it costs
            is the rate limit, not the suggestions. */}
        {discogs?.unavailable && (
          <p className="mt-3 rounded-lg border border-warning-500/40 bg-warning-500/10 px-4 py-3 font-sans text-sm text-warning-500">
            The Keychain could not be read, so a stored credential cannot be
            used. Suggestions keep working at the anonymous rate limit until it
            is entered again; everything else works as usual.
          </p>
        )}

        {discogs?.stored && !discogs.unavailable ? (
          <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
            <span className="inline-flex items-center gap-2 rounded-full bg-success-500/15 px-3 py-1 text-success-500 ring-1 ring-success-500/30">
              <span className="h-1.5 w-1.5 rounded-full bg-success-500" />
              Stored in the Keychain
            </span>
            {/* Which one is in there, and since when — the question the consumer
                key used to answer, without putting credential material on
                screen. */}
            <span className="min-w-0 truncate text-fg-muted">
              {discogs.kind === "token"
                ? "personal access token"
                : "consumer key + secret"}
              {discogs.saved_at ? ` · ${formatDate(discogs.saved_at)}` : ""}
            </span>
            <button
              onClick={forgetDiscogs}
              disabled={discogsBusy}
              className="h-9 inline-flex items-center justify-center ml-auto rounded-md border border-border-strong px-3 enabled:hover:border-danger-500 enabled:hover:text-danger-500 disabled:border-border disabled:text-fg-disabled"
            >
              Remove
            </button>
          </div>
        ) : (
          <>
            <div className="mt-4 flex flex-wrap items-end gap-3">
              <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">
                <span className="text-fg-muted">Personal access token</span>
                <input
                  type="password"
                  value={discogsToken}
                  onChange={(e) => setDiscogsTokenInput(e.target.value)}
                  className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 outline-none focus:border-accent-500"
                />
              </label>
              <button
                onClick={() =>
                  void storeDiscogs(() => setDiscogsToken(discogsToken.trim()))
                }
                disabled={discogsBusy || !discogsToken.trim()}
                className="h-9 inline-flex items-center justify-center rounded-md bg-accent-600 px-4 text-sm font-medium enabled:hover:bg-accent-500 disabled:bg-surface-2 disabled:text-fg-disabled"
              >
                {discogsBusy ? "Saving…" : "Save to Keychain"}
              </button>
            </div>
            {/* Written once and never read back: after this the token is the
                Keychain's, and the app only asks whether it is there. */}
            <p className="mt-3 font-sans text-xs text-fg-subtle">
              The token is not shown again after it is saved.
            </p>

            {/* The older way in. Second, not gone: anyone who already registered
                an application should not have to start over. */}
            <button
              onClick={() => setShowAppForm(!showAppForm)}
              className="mt-3 text-xs underline decoration-dotted underline-offset-2 text-fg-subtle hover:text-fg"
            >
              {showAppForm ? "Hide" : "Already registered a Discogs app?"}
            </button>
            {showAppForm && (
              <>
                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-fg-muted">Consumer key</span>
                    <input
                      value={discogsKey}
                      onChange={(e) => setDiscogsKey(e.target.value)}
                      className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 outline-none focus:border-accent-500"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="text-fg-muted">Consumer secret</span>
                    <input
                      type="password"
                      value={discogsSecret}
                      onChange={(e) => setDiscogsSecret(e.target.value)}
                      className="rounded-lg border border-border-strong bg-surface-2 px-3 py-2 outline-none focus:border-accent-500"
                    />
                  </label>
                </div>
                <button
                  onClick={() =>
                    void storeDiscogs(() =>
                      setDiscogsAppCredentials(
                        discogsKey.trim(),
                        discogsSecret.trim(),
                      ),
                    )
                  }
                  disabled={
                    discogsBusy || !discogsKey.trim() || !discogsSecret.trim()
                  }
                  className="h-9 mt-3 inline-flex items-center justify-center rounded-md border border-border-strong px-4 text-sm enabled:hover:border-accent-500 enabled:hover:text-accent-500 disabled:border-border disabled:text-fg-disabled"
                >
                  {discogsBusy ? "Saving…" : "Save key + secret"}
                </button>
              </>
            )}
          </>
        )}

        {discogsError && (
          <p className="mt-3 text-sm text-danger-500">{discogsError}</p>
        )}
      </section>

      {/* About / updates */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-sm font-semibold text-fg">About</h2>

        {update ? (
          <>
            {/* A release that marked itself critical in the changelog is a
                security or data-loss fix, so it is said in the same shape as
                the sidecar failure in the library view rather than as a pill:
                the state, not a suggestion. */}
            {update.severity === "critical" ? (
              <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-danger-500/40 bg-danger-500/10 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="text-danger-500">
                    Critical update available — v{update.version}
                  </p>
                  <p className="mt-0.5 font-sans text-fg-muted">
                    This release fixes a security or data-loss problem. Install
                    it now.
                  </p>
                </div>
                <button
                  onClick={runUpdate}
                  disabled={installing}
                  className="h-9 inline-flex items-center justify-center ml-auto rounded-md bg-accent-600 px-4 text-sm font-medium enabled:hover:bg-accent-500 disabled:bg-surface-2 disabled:text-fg-disabled"
                >
                  {installLabel}
                </button>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap items-center gap-3">
                {/* `important` stays a pill and only changes colour: it is worth
                    noticing, but nothing is at risk while it waits, and a
                    banner would spend the loud shape on the quieter case. */}
                <span
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ring-1 ${
                    update.severity === "important"
                      ? "bg-warning-500/15 text-warning-500 ring-warning-500/30"
                      : "bg-accent-500/15 text-accent-300 ring-accent-500/30"
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      update.severity === "important"
                        ? "bg-warning-500"
                        : "bg-accent-500"
                    }`}
                  />
                  {update.severity === "important"
                    ? "Important update available"
                    : "Update available"}
                  : v{update.version}
                </span>
                <button
                  onClick={runUpdate}
                  disabled={installing}
                  className="h-9 inline-flex items-center justify-center rounded-md bg-accent-600 px-4 text-sm font-medium enabled:hover:bg-accent-500 disabled:bg-surface-2 disabled:text-fg-disabled"
                >
                  {installLabel}
                </button>
              </div>
            )}
            {/* What changed, straight from the changelog section for this
                version. Worth showing whatever the severity: deciding whether
                to restart now is easier when you can see what you get. */}
            {updateNotes && (
              <div className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-border bg-surface-2 px-4 py-3">
                <ReleaseNotes notes={updateNotes} size="xs" />
              </div>
            )}
          </>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              onClick={checkUpdates}
              disabled={checking}
              className="h-9 inline-flex items-center justify-center rounded-md border border-border-strong px-3 text-sm enabled:hover:border-accent-500 disabled:border-border disabled:text-fg-disabled"
            >
              {checking ? "Checking…" : "Check for updates"}
            </button>
            {checked && !checking && (
              <span className="text-sm text-fg-subtle">You’re up to date.</span>
            )}
          </div>
        )}

        {/* Support. Outlined rather than accent-filled: the page's primary
            action is the update, and the styleguide keeps one accent. The heart
            is deliberately not danger-red — colour here would read as a state. */}
        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-border pt-4">
          <button
            onClick={() => void openUrl(DONATE_URL)}
            className="h-9 justify-center inline-flex items-center gap-1.5 rounded-md border border-border-strong px-3 text-sm enabled:hover:border-accent-500 enabled:hover:text-accent-400"
          >
            <HeartIcon />
            Donate
          </button>
          <p className="font-sans text-xs text-fg-subtle">
            rekord-lib is free and MIT-licensed. If it saves you an evening of
            re-encoding, you can chip in towards its development.
          </p>
        </div>

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
