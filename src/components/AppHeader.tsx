import type { ReactNode } from "react";
import { useScrolled } from "../lib/useScrolled";

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
          ? "border-neutral-800 bg-neutral-950/80 shadow-lg shadow-black/40 backdrop-blur"
          : "border-neutral-800/60 bg-neutral-900/60"
      }`}
    >
      <button
        onClick={onTitleClick}
        className="min-w-0 text-left"
        title="Zur Library"
      >
        <h1 className="truncate text-xl font-semibold tracking-tight">
          rekord-lib
          <span className="ml-2 hidden text-sm font-normal text-neutral-400 sm:inline">
            CDJ/XDJ- &amp; Rekordbox-kompatible Library
          </span>
        </h1>
      </button>

      <div className="flex shrink-0 items-center gap-2">{right}</div>
    </header>
  );
}
