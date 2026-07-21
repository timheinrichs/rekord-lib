import { useState } from "react";
import { formatBytes } from "../lib/format";
import type { DownloadEntry } from "../lib/useBandcamp";
import { DownloadIcon, GearIcon } from "./icons";

export type MainView = "library" | "bandcamp";

interface Props {
  view: MainView;
  onNavigate: (view: MainView) => void;
  downloads: Record<string, DownloadEntry>;
  onClearDownloads: () => void;
  onOpenSettings: () => void;
  updateAvailable?: boolean;
}

/**
 * Shared right-side header navigation: Library / Bandcamp tabs, the downloads
 * overlay and the settings gear. Rendered by both main views.
 */
export default function HeaderNav({
  view,
  onNavigate,
  downloads,
  onClearDownloads,
  onOpenSettings,
  updateAvailable,
}: Props) {
  const [downloadsOpen, setDownloadsOpen] = useState(false);

  const downloadList = Object.values(downloads);
  const active = downloadList.filter((d) => d.state === "loading").length;

  return (
    <>
      <nav className="flex items-center gap-1 rounded-lg border border-border-strong p-0.5">
        <TabButton
          label="Library"
          active={view === "library"}
          onClick={() => onNavigate("library")}
        />
        <TabButton
          label="Bandcamp"
          active={view === "bandcamp"}
          onClick={() => onNavigate("bandcamp")}
        />
      </nav>

      {downloadList.length > 0 && (
        <div className="relative shrink-0">
          <button
            onClick={() => setDownloadsOpen((o) => !o)}
            className="relative flex items-center justify-center rounded-lg border border-border-strong p-2 text-fg-muted hover:border-accent-500 hover:text-accent-400"
            title="Downloads"
            aria-label="Downloads"
          >
            <DownloadIcon />
            {active > 0 && (
              <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-600 px-1 text-[10px] font-medium text-white">
                {active}
              </span>
            )}
          </button>
          {downloadsOpen && (
            <div className="absolute right-0 top-full z-40 mt-2 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-lg shadow-black/40">
              <div className="flex items-center justify-between border-b border-border px-3 py-2">
                <span className="text-xs font-medium text-fg-muted">Downloads</span>
                <div className="flex items-center gap-2">
                  {downloadList.some((d) => d.state !== "loading") && (
                    <button
                      onClick={onClearDownloads}
                      className="text-xs text-fg-subtle hover:text-fg"
                    >
                      Clear
                    </button>
                  )}
                  <button
                    onClick={() => setDownloadsOpen(false)}
                    className="text-fg-subtle hover:text-fg"
                    aria-label="Close"
                  >
                    ✕
                  </button>
                </div>
              </div>
              <div className="max-h-80 overflow-y-auto">
                {downloadList.map((d) => {
                  const pct = d.total > 0 ? Math.round((d.downloaded / d.total) * 100) : 0;
                  return (
                    <div key={d.key} className="border-b border-border/60 px-3 py-2 last:border-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm text-fg" title={d.title}>
                          {d.title}
                        </span>
                        <span className="shrink-0 text-xs text-fg-subtle">
                          {d.state === "done"
                            ? "✓ Done"
                            : d.state === "error"
                              ? "Error"
                              : d.total > 0
                                ? `${pct}%`
                                : d.stage}
                        </span>
                      </div>
                      {d.band && <p className="truncate text-xs text-fg-subtle">{d.band}</p>}
                      {d.state === "loading" && (
                        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
                          <div
                            className={`h-full rounded-full bg-accent-500 transition-all duration-300 ${
                              d.total > 0 ? "" : "w-1/3 animate-pulse"
                            }`}
                            style={d.total > 0 ? { width: `${pct}%` } : undefined}
                          />
                        </div>
                      )}
                      {d.state === "loading" && d.total > 0 && (
                        <p className="mt-1 text-[11px] text-fg-subtle">
                          {formatBytes(d.downloaded)} / {formatBytes(d.total)} · {d.stage}
                        </p>
                      )}
                      {d.state === "error" && d.error && (
                        <p className="mt-1 truncate text-[11px] text-danger-500" title={d.error}>
                          {d.error}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      <button
        onClick={onOpenSettings}
        className="relative shrink-0 rounded-lg border border-border-strong p-2 text-fg-muted hover:border-accent-500 hover:text-accent-400"
        title={updateAvailable ? "Settings · update available" : "Settings"}
        aria-label={updateAvailable ? "Settings, update available" : "Settings"}
      >
        <GearIcon />
        {updateAvailable && (
          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-accent-500 ring-2 ring-bg" />
        )}
      </button>
    </>
  );
}

function TabButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
        active
          ? "bg-accent-600/20 text-accent-200"
          : "text-fg-muted hover:text-fg"
      }`}
    >
      {label}
    </button>
  );
}
