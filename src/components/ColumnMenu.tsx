import { useState } from "react";
import { useDismiss } from "../lib/useDismiss";
import { ColumnsIcon } from "./icons";
import {
  columnLabel,
  hideableColumns,
  toggleColumn,
  type ColumnId,
} from "../lib/columns";

interface Props {
  /** Column ids the user has switched off. */
  hidden: ColumnId[];
  onChange: (next: ColumnId[]) => void;
}

/**
 * Which columns the library table shows.
 *
 * Sits left of the filter, because it changes what the table *is* rather than
 * what it contains — a hidden column is not a narrowed list. Everything is on by
 * default, and the columns that carry selection or hierarchy are not offered:
 * hiding those would leave a list that cannot be operated, which is a broken
 * state rather than a preference.
 */
export default function ColumnMenu({ hidden, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const columns = hideableColumns();
  const someHidden = hidden.length > 0;

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`relative flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
          open || someHidden
            ? "border-accent-500 text-accent-400"
            : "border-border-strong text-fg-muted hover:border-accent-500 hover:text-accent-400"
        }`}
        title="Choose columns"
        aria-label="Choose columns"
        aria-expanded={open}
      >
        <ColumnsIcon />
        {someHidden && (
          <span
            className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent-500"
            aria-hidden="true"
          />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-56 rounded-lg border border-border bg-surface p-2 shadow-md">
          <p className="px-2 pb-2 pt-1 text-xs text-fg-muted">Columns</p>
          <div className="max-h-72 overflow-y-auto">
            {columns.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={!hidden.includes(c.id)}
                  onChange={() => onChange(toggleColumn(hidden, c.id))}
                  className="h-4 w-4 rounded border-border-strong bg-surface-2"
                />
                <span className="text-fg">{columnLabel(c)}</span>
              </label>
            ))}
          </div>
          {someHidden && (
            <button
              onClick={() => onChange([])}
              className="h-9 inline-flex items-center justify-center mt-1 w-full rounded-md px-2 text-left text-sm text-fg-muted hover:bg-surface-2 hover:text-fg"
            >
              Show all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
