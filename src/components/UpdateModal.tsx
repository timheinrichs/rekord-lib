import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Overlay from "./Overlay";
import { installUpdate, type UpdateInfo } from "../lib/updater";

const RELEASES_URL = "https://github.com/timheinrichs/rekord-lib/releases/tag/v";

interface Props {
  update: UpdateInfo;
  onClose: () => void;
}

/**
 * The update prompt on start-up.
 *
 * Shown rather than left to the gear badge because an update nobody notices is
 * an update nobody installs — and this is the path a security fix has to travel.
 * Dismissible either way: the app works, and interrupting a launch to force a
 * restart would be worse than the version gap.
 */
export default function UpdateModal({ update, onClose }: Props) {
  const [installing, setInstalling] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const critical = update.severity === "critical";

  const install = async () => {
    setInstalling(true);
    setError(null);
    setPct(0);
    try {
      await installUpdate((downloaded, total) => {
        setPct(total ? Math.round((downloaded / total) * 100) : null);
      });
      // On success the app relaunches; there is nothing after this.
    } catch (e) {
      setError(`Update failed: ${e}`);
      setInstalling(false);
      setPct(null);
    }
  };

  return (
    <Overlay>
      <div className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-3">
          <div className="min-w-0">
            <h2
              className={`text-sm font-medium ${critical ? "text-danger-500" : "text-fg"}`}
            >
              {critical ? "Critical update available" : "Update available"}
            </h2>
            <p className="mt-0.5 text-xs text-fg-subtle">
              v{update.currentVersion} → v{update.version}
            </p>
          </div>
          <button
            onClick={onClose}
            disabled={installing}
            className="shrink-0 text-fg-muted enabled:hover:text-fg disabled:text-fg-disabled"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {/* Only said for a critical release: on an ordinary one it would be
              noise, and the styleguide keeps status colour for state. */}
          {critical && (
            <p className="mb-3 rounded-lg border border-danger-500/40 bg-danger-500/10 px-3 py-2 font-sans text-sm text-danger-500">
              This release fixes a security or data-loss problem.
            </p>
          )}
          {update.notes ? (
            <pre className="whitespace-pre-wrap font-sans text-sm text-fg-muted">
              {update.notes}
            </pre>
          ) : (
            <p className="font-sans text-sm text-fg-subtle">
              This release came without notes.
            </p>
          )}
        </div>

        <footer className="flex items-center gap-3 border-t border-border px-5 py-3">
          <button
            onClick={() => void openUrl(RELEASES_URL + update.version)}
            className="font-sans text-sm text-fg-muted underline decoration-dotted underline-offset-2 hover:text-accent-400"
          >
            View on GitHub
          </button>
          {error && (
            <p className="min-w-0 truncate text-sm text-danger-500" title={error}>
              {error}
            </p>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <button
              onClick={onClose}
              disabled={installing}
              className="rounded-lg border border-border-strong px-3 py-1.5 text-sm enabled:hover:border-accent-500 disabled:border-border disabled:text-fg-disabled"
            >
              Cancel
            </button>
            <button
              onClick={() => void install()}
              disabled={installing}
              className="rounded-lg bg-accent-600 px-4 py-1.5 text-sm font-medium enabled:hover:bg-accent-500 disabled:bg-surface-2 disabled:text-fg-disabled"
            >
              {installing
                ? pct != null
                  ? `Updating… ${pct}%`
                  : "Updating…"
                : "Update"}
            </button>
          </div>
        </footer>
      </div>
    </Overlay>
  );
}
