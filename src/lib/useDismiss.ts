import { useEffect, useRef } from "react";

/**
 * Closes a popover on Escape or on a pointer press outside of it.
 *
 * Returns the ref to put on the popover's outermost element — including the
 * button that toggles it, otherwise the press that closes the popover would
 * immediately be treated as a press on the button and reopen it.
 *
 * Listens on `pointerdown` rather than `click`: a click only lands after the
 * button is released, which lets a press-and-drag escape the check.
 */
export function useDismiss<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
) {
  const ref = useRef<T>(null);
  // Kept in a ref so the listeners are attached once per open, not per render.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const el = ref.current;
      if (el && !el.contains(e.target as Node)) closeRef.current();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return ref;
}
