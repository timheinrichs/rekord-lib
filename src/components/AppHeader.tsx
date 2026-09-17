import type { ReactNode } from "react";
import { useScrolled } from "../lib/useScrolled";
import logoDark from "../assets/brand/rekord-lib-logo-horizontal-dark.svg";
import logoLight from "../assets/brand/rekord-lib-logo-horizontal.svg";

interface Props {
  /**
   * What this screen is, as one word or two. Rendered as the view's `h1` and
   * visually hidden — the design's header is a logo and a row of actions, with
   * nowhere to put a page title, but the screen still has a name and a document
   * still needs a top-level heading. Every view that renders a header passes
   * one, which is what keeps it at exactly one `h1` per screen.
   */
  title: string;
  /** Right-aligned actions (primary buttons, gear, "Done" …). */
  right?: ReactNode;
  /** Click on the title (usually back to the library). */
  onTitleClick?: () => void;
}

/**
 * Sticky app header with the title on the left and an actions slot on the right.
 * On scroll it docks with a shadow.
 *
 * Docking used to add `backdrop-blur` over a `bg-bg/80` background, and that is
 * what made scrolling stutter the moment the header became sticky: a
 * `backdrop-filter` has to re-sample and re-blur everything beneath it on every
 * frame the content moves, and beneath this is a full-width virtualized table.
 * The filter bar below did the same at the same scroll threshold, so two
 * full-width blurs appeared at once.
 *
 * Twenty per cent show-through is what that bought. The docked surface is
 * opaque now and the shadow does the work of saying it floats — which is what
 * `DESIGN.md`'s Tone-Before-Shadow rule asks for anyway.
 */
export default function AppHeader({ title, right, onTitleClick }: Props) {
  const scrolled = useScrolled(4);
  return (
    <header
      className={`sticky top-0 z-30 flex h-16 items-center justify-between gap-4 border-b px-6 transition-[box-shadow,background-color,border-color] duration-300 ${
        scrolled
          ? "border-border bg-bg shadow-lg shadow-black/40"
          : "border-border bg-surface"
      }`}
    >
      <h1 className="sr-only">{title}</h1>
      <div className="flex min-w-0 items-center gap-2">
        <button
          onClick={onTitleClick}
          className="flex min-w-0 items-center gap-3 text-left"
          title="To library"
        >
          {/* Two files, not one recoloured: the wordmark is converted to paths
              and the styleguide forbids recolouring it, so the light and dark
              variants are the assets the brand ships. Swapped in CSS through
              the `dark:` variant rather than in JS, so it cannot fall out of
              step with the theme that is actually applied.

              Only one is ever visible, so only one carries the alt text — two
              would announce the app's name twice. */}
          <img
            src={logoLight}
            alt="rekord-lib"
            className="h-7 w-auto shrink-0 dark:hidden"
            draggable={false}
          />
          <img
            src={logoDark}
            alt=""
            aria-hidden="true"
            className="hidden h-7 w-auto shrink-0 dark:block"
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
          ? "bg-warning-500/15 text-fg-warning ring-warning-500/30"
          : "bg-accent-500/15 text-fg-accent ring-accent-500/30"
      }`}
      title={dev ? "Development build" : "Beta build – expect rough edges"}
    >
      {dev ? "dev" : "Beta"}
    </span>
  );
}
