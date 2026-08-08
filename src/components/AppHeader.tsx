import type { ReactNode } from "react";
import { useScrolled } from "../lib/useScrolled";
import logoUrl from "../assets/brand/rekord-lib-logo-horizontal-dark.svg";

interface Props {
  /** Right-aligned actions (primary buttons, gear, "Done" …). */
  right?: ReactNode;
  /** Click on the title (usually back to the library). */
  onTitleClick?: () => void;
}

/**
 * Sticky app header with the title on the left and an actions slot on the right.
 * On scroll it gently docks with a shadow/blur.
 */
export default function AppHeader({ right, onTitleClick }: Props) {
  const scrolled = useScrolled(4);
  return (
    <header
      className={`sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b px-6 transition-[box-shadow,background-color,border-color] duration-300 ${
        scrolled
          ? "border-border bg-bg/80 shadow-lg shadow-black/40 backdrop-blur"
          : "border-border bg-surface"
      }`}
    >
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={onTitleClick}
          className="flex min-w-0 items-center gap-3 text-left"
          title="To library"
        >
          <img
            src={logoUrl}
            alt="rekord-lib"
            className="h-7 w-auto shrink-0"
            draggable={false}
          />
        </button>
        <BuildChip />
      </div>

      <div className="flex shrink-0 items-center gap-2">{right}</div>
    </header>
  );
}

/**
 * Marks what kind of build this is. Dev keeps the warning tone (it is not a
 * real build); a shipped build reads "Beta" in accent, because that is a
 * heads-up and not a compatibility warning — status colours stay semantic.
 *
 * Deliberately not tied to the app version: dropping the beta label should be
 * a decision, not something to remember on every release.
 */
export function BuildChip() {
  const dev = import.meta.env.DEV;
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-xs ring-1 ${
        dev
          ? "bg-warning-500/15 text-warning-500 ring-warning-500/30"
          : "bg-accent-500/15 text-accent-300 ring-accent-500/30"
      }`}
      title={dev ? "Development build" : "Beta build – expect rough edges"}
    >
      {dev ? "dev" : "Beta"}
    </span>
  );
}
