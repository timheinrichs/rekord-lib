import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AppEvent, EventLevel, EventLog } from "../types";

/**
 * The event log lives in SQLite in the backend: it is written from Rust, it
 * outlives the session, and it is capped there rather than here. This module is
 * the thin wrapper plus the two rules the UI needs — what counts as unread, and
 * how the log reads as text.
 */

/** The log, newest first, with how far the user has read. */
export function loadEvents(): Promise<EventLog> {
  return invoke<EventLog>("events_load");
}

/** Marks everything up to `id` as read, which is what clears the badge. */
export function markEventsSeen(id: number): Promise<void> {
  return invoke("events_mark_seen", { id });
}

/** Empties the log. */
export function clearEvents(): Promise<number> {
  return invoke<number>("events_clear");
}

/** Fires whenever the backend recorded something, so the badge can follow. */
export function onEventLogged(cb: () => void): Promise<UnlistenFn> {
  return listen("events://new", () => cb());
}

/**
 * The level the badge should show, or `null` when everything has been read.
 *
 * Every unread entry counts, including `info`. It used to ignore those, on the
 * grounds that a log full of "scan finished" should not put a dot on the header
 * forever — but the dot is not a warning, it is the answer to "did anything
 * happen while I was not looking", and something that finished *is* an answer.
 * An export that wrote a file to the Desktop had no way of saying so at all
 * under the old rule.
 *
 * The colour carries the difference instead: an error outranks a warning
 * outranks an ordinary message, because the badge has room for one answer and
 * the loudest one is the one worth having.
 */
export function badgeLevel(
  events: AppEvent[],
  seenId: number,
): EventLevel | null {
  const unread = events.filter((e) => e.id > seenId);
  if (unread.some((e) => e.level === "error")) return "error";
  if (unread.some((e) => e.level === "warn")) return "warn";
  if (unread.length) return "info";
  return null;
}

/** How many entries the user has not looked at yet. */
export function unreadCount(events: AppEvent[], seenId: number): number {
  return events.filter((e) => e.id > seenId).length;
}

/**
 * The log as text, for the copy button. Timestamp, level, source, message and
 * detail per line — the form that can be pasted into a bug report and still
 * mean something without the app next to it.
 */
export function eventsAsText(events: AppEvent[]): string {
  return events
    .map((e) => {
      const when = new Date(e.created_ms).toISOString();
      const head = `${when} [${e.level}] ${e.source}: ${e.message}`;
      return e.detail ? `${head} — ${e.detail}` : head;
    })
    .join("\n");
}
