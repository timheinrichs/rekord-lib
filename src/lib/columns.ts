import type { SortKey } from "./grouping";

/**
 * The library table's columns, as data.
 *
 * The point is that there is exactly one list. The header, the group rows and
 * the track rows all iterate it, so a column cannot exist in one and not the
 * others — which is how the three hand-maintained cell lists this replaces
 * drifted apart: nesting was indented on the checkbox in track rows and on the
 * title in group rows, and the label view's tracks lost their checkbox
 * altogether. Order, width and sortability now live in one place, and hiding a
 * column is a filter over it rather than an edit in three.
 */
export type ColumnId =
  | "select"
  | "expand"
  | "cover"
  | "waveform"
  | "title"
  | "artist"
  | "album"
  | "length"
  | "bpm"
  | "key"
  | "format"
  | "downloaded"
  | "status"
  | "actions";

export interface ColumnDef {
  id: ColumnId;
  /** Header text. Empty for the columns that carry a control, not a value. */
  label: string;
  /** Tailwind width class. Omitted for the one column that takes the slack. */
  width?: string;
  /** Sortable by this key, where sorting it means anything. */
  sortKey?: SortKey;
  /**
   * Carries an icon rather than text, and gets narrow padding.
   *
   * Not cosmetic: `w-8` with the standard `px-4` leaves a content box of exactly
   * zero, so the expand chevron rendered into nothing at all when it moved out
   * of the flexible title cell into a column of its own.
   */
  tight?: boolean;
  /**
   * Cannot be hidden. Selection and hierarchy are how the table is *operated* —
   * hiding them would leave a list that cannot be acted on, which is a broken
   * state rather than a preference.
   */
  fixed?: boolean;
}

/**
 * In display order.
 *
 * `title` has no width: it absorbs whatever is left, which is why it is the one
 * column that must not be given one. `expand` is its own column rather than a
 * chevron inside the title cell — that separation is what lets the hierarchy
 * indent live in the title while every checkbox above it stays in line.
 */
export const COLUMNS: ColumnDef[] = [
  { id: "select", label: "", width: "w-10", fixed: true },
  { id: "expand", label: "", width: "w-8", tight: true, fixed: true },
  { id: "cover", label: "", width: "w-14" },
  { id: "waveform", label: "", width: "w-32" },
  { id: "title", label: "Title", sortKey: "title", fixed: true },
  { id: "artist", label: "Artist", width: "w-40", sortKey: "artist" },
  { id: "album", label: "Album", width: "w-40", sortKey: "album" },
  { id: "length", label: "Length", width: "w-20", sortKey: "length" },
  { id: "bpm", label: "BPM", width: "w-20", sortKey: "bpm" },
  // Narrower than it was: the cell used to carry "Am · 8A" and now carries the
  // name alone, which is never wider than "F#m".
  { id: "key", label: "Key", width: "w-16" },
  { id: "format", label: "Format", width: "w-44" },
  { id: "downloaded", label: "Downloaded", width: "w-32", sortKey: "date" },
  { id: "status", label: "Status", width: "w-24" },
  { id: "actions", label: "", width: "w-16", fixed: true },
];

/** The columns to render, in order, given what the user has switched off. */
export function visibleColumns(hidden: readonly ColumnId[]): ColumnDef[] {
  const off = new Set(hidden);
  // A fixed column stays even if a stale setting names it, so a hand-edited
  // store cannot produce a table with no checkboxes.
  return COLUMNS.filter((c) => c.fixed || !off.has(c.id));
}

/** The columns a user may switch off, in display order — for the menu. */
export function hideableColumns(): ColumnDef[] {
  return COLUMNS.filter((c) => !c.fixed);
}

/** Switches one column off, or back on. Fixed columns cannot be switched off. */
export function toggleColumn(
  hidden: readonly ColumnId[],
  id: ColumnId,
): ColumnId[] {
  if (COLUMNS.find((c) => c.id === id)?.fixed) return [...hidden];
  return hidden.includes(id)
    ? hidden.filter((x) => x !== id)
    : [...hidden, id];
}

/**
 * A label for the menu. The control columns have no header text, so they are
 * named here rather than showing an empty checkbox.
 */
export function columnLabel(c: ColumnDef): string {
  if (c.label) return c.label;
  return { cover: "Cover", waveform: "Waveform" }[c.id as string] ?? c.id;
}
