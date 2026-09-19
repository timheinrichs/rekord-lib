import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TOAST_EXIT_MS, TOAST_MS, type Toast } from "../lib/toasts";
import type { EventLevel } from "../types";

/**
 * Status colour per level, in the tinted-ring form.
 *
 * `info` takes the accent, not green. The badge in the header already colours
 * an ordinary message that way, and a toast is the same log row the badge is
 * counting — colouring them differently would be the two halves of one
 * notification disagreeing in hue. It also follows the Semantic Colour Rule's
 * own corollary: green in this app means the file will play on a CDJ, and
 * "moved 3 tracks to the trash" is a heads-up, not a compatibility verdict.
 *
 * Deliberately different from `EventLogModal`'s map, where `info` is
 * `text-fg-subtle`. That one colours a *column of levels*, and subtle is right
 * when the list is the content; this is one sentence that has four seconds to
 * be seen.
 */
const LEVEL_CLASS: Record<EventLevel, string> = {
  info: "bg-accent-500/15 text-fg-accent ring-accent-500/30",
  warn: "bg-warning-500/15 text-fg-warning ring-warning-500/30",
  error: "bg-danger-500/15 text-fg-danger ring-danger-500/30",
};

function ToastRow({ toast, onExpire }: { toast: Toast; onExpire: () => void }) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const out = setTimeout(() => setLeaving(true), TOAST_MS - TOAST_EXIT_MS);
    const gone = setTimeout(onExpire, TOAST_MS);
    return () => {
      clearTimeout(out);
      clearTimeout(gone);
    };
    // Its own id is the identity: a new toast is a new row with its own clock,
    // and one leaving must not reset another's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  return (
    // Two elements, because the tint is 15 % and has to composite over a theme
    // surface rather than over the table showing through from behind.
    <div
      className={`pointer-events-none rounded-lg bg-surface shadow-lg shadow-black/40 ${
        leaving ? "animate-fade-out" : "animate-fade-in"
      }`}
    >
      <div
        className={`max-w-sm rounded-lg px-4 py-3 text-sm ring-1 ${LEVEL_CLASS[toast.level]}`}
      >
        {toast.message}
      </div>
    </div>
  );
}

/**
 * What the app just did, said out loud for four seconds.
 *
 * Every message here is an event log row on its way past — the same id, the
 * same sentence, written once in the backend. Nothing raises one on its own,
 * which is what keeps the transient message and the durable log from ever
 * disagreeing about what happened.
 *
 * Portalled for the same reason `Overlay` is: `position: fixed` resolves
 * against the nearest ancestor that establishes a containing block, and the
 * view wrappers in `App.tsx` carry `animate-fade-in`, which touches
 * `transform`. Inside one, this would anchor to the document rather than to the
 * screen.
 *
 * **Top right, under the header**, which is the corner nothing else claims:
 * the bottom right holds the back-to-top button, the bottom edge is the player
 * bar, and the top centre is the header itself. It sits at `z-[60]`, the one
 * floor above the modal backdrop, because a conversion finishing behind the
 * event log is exactly when silence is worst — and it is
 * `pointer-events-none` throughout, so it covers without ever intercepting a
 * click on what is underneath.
 *
 * Never `inset-0` and never `z-50`: `appDom.overlay()` finds the topmost dialog
 * by exactly those two classes, and a toast wearing them would be picked up as
 * "the dialog on top" in every flow test in the suite.
 *
 * It is **always mounted**, empty or not. A live region that arrives in the DOM
 * at the same moment as its content is not reliably announced, and this is the
 * app's only app-level announcer — the scan's own region lives inside
 * `LibraryView`, which a message about a finished export outlives.
 *
 * No pause, no close button, no click through to the log. Every affordance
 * added to a transient message is a reason to look at it, and the durable copy
 * is one click away in the header with a badge already pointing at it.
 */
export default function Toasts({
  toasts,
  onExpire,
}: {
  toasts: Toast[];
  onExpire: (id: number) => void;
}) {
  return createPortal(
    <div
      role="status"
      aria-live="polite"
      aria-label="Notifications"
      className="pointer-events-none fixed right-6 top-20 z-[60] flex flex-col items-end gap-2"
    >
      {toasts.map((t) => (
        <ToastRow key={t.id} toast={t} onExpire={() => onExpire(t.id)} />
      ))}
    </div>,
    document.body,
  );
}
