import type { ReactNode } from "react";
import { useScrolled } from "../lib/useScrolled";
import logoUrl from "../assets/brand/rekord-lib-logo-horizontal-dark.svg";

interface Props {
  /** Rechtsbündige Aktionen (primäre Buttons, Zahnrad, „Fertig" …). */
  right?: ReactNode;
  /** Klick auf den Titel (i. d. R. zurück zur Library). */
  onTitleClick?: () => void;
}

/**
 * Sticky-App-Header mit Titel links und Aktions-Slot rechts.
 * Beim Scrollen dockt er per Schatten/Blur sanft an.
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
      <button
        onClick={onTitleClick}
        className="flex min-w-0 items-center gap-3 text-left"
        title="Zur Library"
      >
        <img
          src={logoUrl}
          alt="rekord-lib"
          className="h-7 w-auto shrink-0"
          draggable={false}
        />
      </button>

      <div className="flex shrink-0 items-center gap-2">{right}</div>
    </header>
  );
}
