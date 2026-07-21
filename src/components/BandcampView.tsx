import { useState, type ReactNode } from "react";
import AppHeader from "./AppHeader";
import HeaderNav from "./HeaderNav";
import { GridIcon, ListIcon } from "./icons";
import type { BulkProgress, DownloadEntry } from "../lib/useBandcamp";
import type { BandcampAccount, BandcampItem } from "../types";

interface Props {
  account: BandcampAccount | null;
  libraryDir: string | null;
  collection: BandcampItem[];
  downloads: Record<string, DownloadEntry>;
  refreshing: boolean;
  bulk: BulkProgress | null;
  error: string | null;
  /** Bandcamp item keys already present in the local library. */
  presentKeys: Set<string>;
  onRefresh: () => void;
  onDownloadItem: (item: BandcampItem) => void;
  onDownloadAll: () => void;
  onSyncLibrary: () => void;
  // Shared header nav
  onClearDownloads: () => void;
  onCancelDownload: (key: string) => void;
  onNavigate: (v: "library" | "bandcamp") => void;
  onOpenSettings: () => void;
  updateAvailable?: boolean;
  onTitleClick?: () => void;
}

export default function BandcampView({
  account,
  libraryDir,
  collection,
  downloads,
  refreshing,
  bulk,
  error,
  presentKeys,
  onRefresh,
  onDownloadItem,
  onDownloadAll,
  onSyncLibrary,
  onClearDownloads,
  onCancelDownload,
  onNavigate,
  onOpenSettings,
  updateAvailable,
  onTitleClick,
}: Props) {
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const nav = (
    <HeaderNav
      view="bandcamp"
      onNavigate={onNavigate}
      downloads={downloads}
      onClearDownloads={onClearDownloads}
      onCancelDownload={onCancelDownload}
      onOpenSettings={onOpenSettings}
      updateAvailable={updateAvailable}
    />
  );

  const canAct = !!account && !!libraryDir && !bulk;
  const missingCount = collection.filter(
    (i) => i.download_page_url && !presentKeys.has(i.key),
  ).length;

  const actions = (
    <>
      {account && (
        <>
          <button
            onClick={onDownloadAll}
            disabled={!canAct || collection.length === 0}
            className="rounded-lg border border-border-strong px-3 py-2 text-sm hover:border-accent-500 disabled:opacity-50"
            title="Download every album and track into the library folder"
          >
            {bulk?.kind === "all"
              ? `Downloading ${bulk.done}/${bulk.total}…`
              : "Download all"}
          </button>
          <button
            onClick={onSyncLibrary}
            disabled={!canAct || missingCount === 0}
            className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium hover:bg-accent-500 disabled:opacity-50"
            title="Download only purchases that are missing locally"
          >
            {bulk?.kind === "sync"
              ? `Syncing ${bulk.done}/${bulk.total}…`
              : `Sync library${missingCount ? ` (${missingCount})` : ""}`}
          </button>
        </>
      )}
      {nav}
    </>
  );

  return (
    <>
      <AppHeader onTitleClick={onTitleClick} right={actions} />
      <main className="mx-auto max-w-5xl px-6 py-6">
        {!account ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-surface py-20 text-center text-fg-subtle">
            <p className="text-lg text-fg-muted">Bandcamp not connected</p>
            <p className="text-sm">
              Connect your account in the settings to see and download your
              purchases.
            </p>
            <button
              onClick={onOpenSettings}
              className="mt-2 rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium hover:bg-accent-500"
            >
              Open settings
            </button>
          </div>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-3">
              <h1 className="text-sm font-semibold text-fg">
                Purchased collection
                <span className="ml-2 text-fg-subtle">{collection.length}</span>
              </h1>
              <button
                onClick={onRefresh}
                disabled={refreshing}
                className="ml-auto rounded-lg border border-border-strong px-3 py-1.5 text-sm text-fg-muted hover:border-accent-500 hover:text-accent-400 disabled:opacity-50"
              >
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
              {/* List / grid toggle, right of Refresh. */}
              <div className="flex items-center gap-0.5 rounded-lg border border-border-strong p-0.5">
                <ViewToggle
                  active={viewMode === "list"}
                  onClick={() => setViewMode("list")}
                  label="List view"
                >
                  <ListIcon />
                </ViewToggle>
                <ViewToggle
                  active={viewMode === "grid"}
                  onClick={() => setViewMode("grid")}
                  label="Grid view"
                >
                  <GridIcon />
                </ViewToggle>
              </div>
            </div>

            {error && (
              <div className="mb-4 rounded-lg border border-danger-500/30 bg-danger-500/10 px-4 py-2 text-sm text-danger-500">
                {error}
              </div>
            )}

            {collection.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-border bg-surface text-fg-subtle">
                <p className="text-sm">
                  {refreshing ? "Loading collection…" : "No purchases found."}
                </p>
              </div>
            ) : viewMode === "list" ? (
              <div className="flex flex-col gap-2">
                {collection.map((item) => (
                  <BandcampRow
                    key={item.key}
                    item={item}
                    inLibrary={presentKeys.has(item.key)}
                    state={downloads[item.key]?.state}
                    disabled={!libraryDir || !!bulk}
                    onDownload={() => onDownloadItem(item)}
                  />
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {collection.map((item) => (
                  <BandcampCard
                    key={item.key}
                    item={item}
                    inLibrary={presentKeys.has(item.key)}
                    state={downloads[item.key]?.state}
                    disabled={!libraryDir || !!bulk}
                    onDownload={() => onDownloadItem(item)}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </>
  );
}

function BandcampRow({
  item,
  inLibrary,
  state,
  disabled,
  onDownload,
}: {
  item: BandcampItem;
  inLibrary: boolean;
  state?: DownloadEntry["state"];
  disabled: boolean;
  onDownload: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2">
      {item.art_url ? (
        <img src={item.art_url} className="h-12 w-12 shrink-0 rounded object-cover" alt="" />
      ) : (
        <div className="h-12 w-12 shrink-0 rounded bg-surface-2" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm text-fg" title={item.title}>
            {item.title}
          </p>
          <span className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-fg-subtle ring-1 ring-border">
            {item.item_type}
          </span>
        </div>
        <p className="truncate text-xs text-fg-subtle">{item.band_name}</p>
      </div>
      {inLibrary && (
        <span className="shrink-0 rounded-full bg-success-500/15 px-2 py-0.5 text-xs text-success-500 ring-1 ring-success-500/30">
          In library
        </span>
      )}
      <button
        onClick={onDownload}
        disabled={!item.download_page_url || disabled || state === "loading"}
        className="shrink-0 rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium hover:bg-accent-500 disabled:opacity-40"
      >
        {downloadLabel(state)}
      </button>
    </div>
  );
}

function BandcampCard({
  item,
  inLibrary,
  state,
  disabled,
  onDownload,
}: {
  item: BandcampItem;
  inLibrary: boolean;
  state?: DownloadEntry["state"];
  disabled: boolean;
  onDownload: () => void;
}) {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-surface">
      <div className="relative aspect-square w-full bg-surface-2">
        {item.art_url && (
          <img src={item.art_url} className="h-full w-full object-cover" alt="" />
        )}
        <span className="absolute left-1.5 top-1.5 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] uppercase text-white backdrop-blur">
          {item.item_type}
        </span>
        {inLibrary && (
          <span className="absolute right-1.5 top-1.5 rounded-full bg-success-500/90 px-1.5 py-0.5 text-[10px] font-medium text-white">
            In library
          </span>
        )}
      </div>
      <div className="flex flex-col gap-1 p-2">
        <p className="truncate text-sm text-fg" title={item.title}>
          {item.title}
        </p>
        <p className="truncate text-xs text-fg-subtle">{item.band_name}</p>
        <button
          onClick={onDownload}
          disabled={!item.download_page_url || disabled || state === "loading"}
          className="mt-1 w-full rounded-lg bg-accent-600 px-3 py-1.5 text-xs font-medium hover:bg-accent-500 disabled:opacity-40"
        >
          {downloadLabel(state)}
        </button>
      </div>
    </div>
  );
}

function downloadLabel(state?: DownloadEntry["state"]): string {
  return state === "loading"
    ? "Loading…"
    : state === "done"
      ? "✓ Downloaded"
      : state === "error"
        ? "Retry"
        : "Download";
}

function ViewToggle({
  active,
  onClick,
  label,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={`flex h-7 w-7 items-center justify-center rounded-md ${
        active ? "bg-accent-600/20 text-accent-200" : "text-fg-muted hover:text-fg"
      }`}
    >
      {children}
    </button>
  );
}
