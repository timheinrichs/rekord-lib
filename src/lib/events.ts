import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type { AppEvent, EventLevel, EventLog, EventNotice } from "../types";

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

/**
 * Fires whenever the backend recorded something, so the badge can follow — and
 * hands over what it recorded, so a message shown on its way past can be the
 * same entry rather than a second account of it.
 *
 * The payload is why this is one channel rather than two. The emit sits inside
 * `events::store`, on the arm where the row was written, so nothing can be
 * announced that is not also in the log.
 */
export function onEventLogged(
  cb: (notice: EventNotice) => void,
): Promise<UnlistenFn> {
  return listen<EventNotice>("events://new", (e) => cb(e.payload));
}

/**
 * The level the badge should show, or `null` when nothing unread needs
 * attention.
 *
 * This rule has now been written twice, and the second version is only right
 * because of what changed under it. It first ignored `info`, so a log full of
 * "scan finished" would not put a dot on the header forever. Then it counted
 * every unread row, with the argument that the dot is not a warning but the
 * answer to "did anything happen while I was not looking" — and, decisively,
 * that an export which wrote a file to the Desktop *had no other way of saying
 * so at all*.
 *
 * It has one now. Since 0.10.0 an action's own answer is shown when it
 * happens (`Toasts`), and seven commands record an `Info` where one used to, so
 * counting them here lights the dot permanently about messages the user has
 * already read. A hint that is always on distinguishes nothing, so `info` is
 * back out: the dot means something wants attention, and the colour still
 * carries which — an error outranks a warning, because the badge has room for
 * one answer and the loudest is the one worth having.
 *
 * What that costs, said out loud: an action that finished while nobody was
 * looking leaves no dot. It is in the log, and nothing points at it. That is
 * the trade the transient message bought, and if the messages ever stop being
 * shown this rule has to be reconsidered with them.
 */
export type BadgeLevel = Extract<EventLevel, "warn" | "error">;

export function badgeLevel(
  events: AppEvent[],
  seenId: number,
): BadgeLevel | null {
  const unread = events.filter((e) => e.id > seenId);
  if (unread.some((e) => e.level === "error")) return "error";
  if (unread.some((e) => e.level === "warn")) return "warn";
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
