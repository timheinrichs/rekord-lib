import { useState } from "react";
import Overlay from "./Overlay";
import { clearEvents, eventsAsText } from "../lib/events";
import type { AppEvent, EventLevel } from "../types";

interface Props {
  events: AppEvent[];
  onClose: () => void;
  /** Re-reads the log after it was emptied. */
  onCleared: () => void;
}

/** Status colour per level — the same three the rest of the app uses. */
const LEVEL_CLASS: Record<EventLevel, string> = {
  info: "text-fg-subtle",
  warn: "text-warning-500",
  error: "text-danger-500",
};

function time(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

/**
 * What the app did and what failed, kept across restarts.
 *
 * These are the failures the app survived without telling anyone: a cache it
 * could not read, rows it could not persist, a file it left out. Each one
 * explains behaviour that would otherwise look arbitrary, so the list is
 * copyable as text — that is the form a bug report needs.
 */
export default function EventLogModal({ events, onClose, onCleared }: Props) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(eventsAsText(events));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const clear = async () => {
    setBusy(true);
    try {
      await clearEvents();
      onCleared();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Overlay>
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-medium">
            Event log
            {events.length > 0 && (
              <span className="ml-2 text-fg-subtle">
                {events.length === 1 ? "1 entry" : `${events.length} entries`}
              </span>
            )}
          </h2>
          <div className="flex items-center gap-3">
            {events.length > 0 && (
              <>
                <button
                  onClick={() => void copy()}
                  className="rounded-md border border-border-strong px-3 py-1.5 text-sm hover:border-accent-500"
                  title="Copy the whole log as text"
                >
                  {copied ? "Copied" : "Copy"}
                </button>
                <button
                  onClick={() => void clear()}
                  disabled={busy}
                  className="rounded-md border border-border-strong px-3 py-1.5 text-sm text-fg-muted enabled:hover:border-danger-500 enabled:hover:text-danger-500 disabled:text-fg-disabled"
                  title="Empty the log"
                >
                  Clear
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="text-fg-muted hover:text-fg"
              aria-label="Close"
            >
              ✕
            </button>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          {events.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-fg-muted">
              <p className="text-lg text-fg">Nothing to report</p>
              <p className="font-sans text-sm">
                Problems the app worked around show up here.
              </p>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {events.map((e) => (
                <li
                  key={e.id}
                  className="rounded-lg border border-border bg-surface-2 px-3 py-2"
                >
                  <div className="flex items-baseline gap-2">
                    <span className={`text-xs ${LEVEL_CLASS[e.level]}`}>
                      {e.level}
                    </span>
                    <span className="text-xs text-fg-subtle">{e.source}</span>
                    <span className="ml-auto shrink-0 text-xs text-fg-subtle">
                      {time(e.created_ms)}
                    </span>
                  </div>
                  <p className="mt-1 text-sm">{e.message}</p>
                  {e.detail && (
                    <p
                      className="mt-0.5 break-all text-xs text-fg-subtle"
                      title={e.detail}
                    >
                      {e.detail}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Overlay>
  );
}
