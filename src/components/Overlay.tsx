import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useScrollLock } from "../lib/useScrollLock";

/**
 * The overlays on screen, innermost last.
 *
 * Counted the way `useScrollLock` counts, and for the same case: the duplicates
 * list opens over the metadata editor, and one Escape has to close one dialog.
 * Without this, both listeners fire and the stack collapses at a keystroke.
 */
const stack: symbol[] = [];

/**
 * Backdrop and centering for the modal dialogs, rendered into `document.body`.
 *
 * The portal is not decoration: `position: fixed` resolves against the nearest
 * ancestor that establishes a containing block, and a transform — even one an
 * animation only touches briefly, as `animate-fade-in` does to the view wrapper
 * in `App.tsx` — is enough to create one. A modal inside such a wrapper centers
 * on the whole document instead of the screen, which put it far below the fold
 * on a long track list. Rendering into `body` takes the overlay out of that
 * question entirely rather than relying on no ancestor ever growing a transform.
 *
 * It also holds the page still while it is open. The list behind a dialog used
 * to keep scrolling under the wheel, which reads as if the dialog were a
 * picture of the app rather than the thing you are talking to.
 *
 * **Escape is opt-in**, by passing `onClose`. It is not given to every dialog
 * because two of them hold unsaved typing — the metadata editors — and losing a
 * form to a keystroke aimed at a field is worse than having to reach for the
 * close button. A dialog that only shows something should take it; one you can
 * type into should not. Backdrop-click is deliberately absent for the same
 * reason and one more: a mis-aimed drag can end on the backdrop, a deliberate
 * keypress cannot.
 */
export default function Overlay({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose?: () => void;
}) {
  useScrollLock();
  // Read through a ref so a new `onClose` identity each render does not
  // re-register the listener, which would reorder the stack.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const id = Symbol("overlay");
    stack.push(id);
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (stack[stack.length - 1] !== id) return;
      close.current?.();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      stack.splice(stack.indexOf(id), 1);
    };
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      {children}
    </div>,
    document.body,
  );
}
