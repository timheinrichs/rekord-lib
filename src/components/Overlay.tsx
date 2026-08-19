import type { ReactNode } from "react";
import { createPortal } from "react-dom";

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
 */
export default function Overlay({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      {children}
    </div>,
    document.body,
  );
}
