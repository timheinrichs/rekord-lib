import { useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import Overlay from "./Overlay";
import ReleaseNotes from "./ReleaseNotes";
import { installUpdate, type UpdateInfo } from "../lib/updater";
import { renderableNotes, type Severity } from "../lib/changelog";

const RELEASES_URL = "https://github.com/timheinrichs/rekord-lib/releases/tag/v";

/** Tag colour per level, in the shape the collection view uses for status. */
const TAG_CLASS: Record<Severity, string> = {
  critical: "bg-danger-500/15 text-danger-500 ring-danger-500/30",
  important: "bg-warning-500/15 text-warning-500 ring-warning-500/30",
};

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
  const severity = update.severity;
  const critical = severity === "critical";
  // Notes that are nothing but the severity marker are notes with nothing in
  // them, and the dialog would otherwise show a header over blank space.
  const notes = renderableNotes(update.notes);

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
            <h2 className="text-base font-medium text-fg">Update available</h2>
            <div className="mt-0.5 flex items-center gap-2">
              <p className="text-xs text-fg-subtle">
                v{update.currentVersion} → v{update.version}
              </p>
              {/* The severity as a tag beside the version rather than in the
                  title: the heading says what the dialog is, the tag says what
                  kind of release it is about. */}
              {severity && (
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-xs ring-1 ${TAG_CLASS[severity]}`}
                >
                  {severity}
                </span>
              )}
            </div>
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
          {/* Only for a critical release, because it is a specific claim about
              what is at risk and `important` makes no such claim — its tag says
              everything there is to say. Colour alone carries it: the tag above
              is already the marker, and a panel repeating it says it twice. */}
          {critical && (
            <p className="mb-3 font-sans text-sm text-danger-500">
              This release fixes a security or data-loss problem.
            </p>
          )}
          {notes ? (
            <ReleaseNotes notes={notes} />
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
              className="h-9 inline-flex items-center justify-center rounded-md border border-border-strong px-3 text-sm enabled:hover:border-accent-500 disabled:border-border disabled:text-fg-disabled"
            >
              Cancel
            </button>
            <button
              onClick={() => void install()}
              disabled={installing}
              className="h-9 inline-flex items-center justify-center rounded-md bg-accent-600 px-4 text-sm font-medium enabled:hover:bg-accent-500 disabled:bg-surface-2 disabled:text-fg-disabled"
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
