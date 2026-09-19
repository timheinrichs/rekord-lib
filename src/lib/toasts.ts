import type { EventLevel, EventNotice } from "../types";

/**
 * What the app shows on its way past, and the one rule about what it does not.
 *
 * A toast here is not a second reporting channel — it is an event log row drawn
 * transiently. The backend decides which rows are worth showing, because the
 * backend is the only place that knows whether a record is an action's own
 * answer or one of the many a scan writes per file. So this module is small on
 * purpose: it filters on the flag that decision produced, and it keeps the
 * stack short.
 */

export interface Toast {
  /**
   * The log row this is a copy of. The same id, so the two cannot drift, and so
   * a notice delivered twice replaces rather than doubles.
   */
  id: number;
  level: EventLevel;
  message: string;
}

/**
 * How many stand at once. Past three the stack is a list, and a list is
 * something you read rather than something you glance at.
 */
export const MAX_TOASTS = 3;

/** How long one stays. */
export const TOAST_MS = 4000;

/** Matches `--animate-fade-out` in tokens.css. */
export const TOAST_EXIT_MS = 150;

/**
 * The notice as a toast, or `null` when it is one of the many the log collects
 * per file.
 *
 * The filter is a flag rather than a list of sources, because `source` is
 * documented as a label in a panel and not something to branch on — an
 * allowlist here would stop working the day somebody renames one, and nothing
 * would fail.
 */
export function toastFor(notice: EventNotice): Toast | null {
  if (!notice.announce) return null;
  return { id: notice.id, level: notice.level, message: notice.message };
}

/** The stack after `next` arrives: newest last, same id replaced, oldest dropped. */
export function pushToast(stack: Toast[], next: Toast): Toast[] {
  const without = stack.filter((t) => t.id !== next.id);
  return [...without, next].slice(-MAX_TOASTS);
}

/** The stack without `id`; a no-op for one that is already gone. */
export function dismissToast(stack: Toast[], id: number): Toast[] {
  return stack.filter((t) => t.id !== id);
}
