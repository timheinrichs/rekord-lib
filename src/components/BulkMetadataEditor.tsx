import { useState } from "react";
import type { TrackMetadata } from "../types";

/** Fields that can be set via bulk edit. */
export type BulkPatch = Partial<
  Pick<
    TrackMetadata,
    "artist" | "album" | "album_artist" | "genre" | "year" | "label" | "catalog_number"
  >
>;

interface Props {
  count: number;
  /** Existing values per field as selection suggestions. */
  suggestions?: Record<string, string[]>;
  onClose: () => void;
  onApply: (patch: BulkPatch) => void;
}

type FieldKey = keyof BulkPatch;

const FIELDS: { key: FieldKey; label: string }[] = [
  { key: "album", label: "Album" },
  { key: "album_artist", label: "Album Artist" },
  { key: "artist", label: "Artist" },
  { key: "genre", label: "Genre" },
  { key: "year", label: "Year" },
  { key: "label", label: "Label" },
  { key: "catalog_number", label: "Catalog no." },
];

/**
 * Sets selected metadata fields for multiple tracks at once.
 * Only checked fields are applied – an empty value clears the field.
 */
export default function BulkMetadataEditor({
  count,
  suggestions,
  onClose,
  onApply,
}: Props) {
  const [enabled, setEnabled] = useState<Record<FieldKey, boolean>>({
    album: false,
    album_artist: false,
    artist: false,
    genre: false,
    year: false,
    label: false,
    catalog_number: false,
  });
  const [values, setValues] = useState<Record<FieldKey, string>>({
    album: "",
    album_artist: "",
    artist: "",
    genre: "",
    year: "",
    label: "",
    catalog_number: "",
  });

  const anyEnabled = FIELDS.some((f) => enabled[f.key]);

  const handleApply = () => {
    const patch: BulkPatch = {};
    for (const { key } of FIELDS) {
      if (!enabled[key]) continue;
      const v = values[key].trim();
      patch[key] = v ? v : null;
    }
    onApply(patch);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <header className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-sm font-medium">
            Edit metadata · {count} tracks
          </h2>
          <button
            onClick={onClose}
            className="text-fg-muted hover:text-fg"
          >
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-3 p-5">
          <p className="text-xs text-fg-subtle">
            Check a field to overwrite it for all selected tracks. An empty
            field removes the value.
          </p>
          {FIELDS.map(({ key, label }) => {
            const opts = suggestions?.[key] ?? [];
            const listId = opts.length ? `bulk-dl-${key}` : undefined;
            return (
              <div key={key} className="flex items-center gap-3">
                <label className="flex w-32 shrink-0 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={enabled[key]}
                    onChange={(e) =>
                      setEnabled((s) => ({ ...s, [key]: e.target.checked }))
                    }
                    className="h-4 w-4 rounded border-border-strong bg-surface-2"
                  />
                  <span
                    className={enabled[key] ? "text-fg" : "text-fg-subtle"}
                  >
                    {label}
                  </span>
                </label>
                <input
                  value={values[key]}
                  disabled={!enabled[key]}
                  list={listId}
                  onChange={(e) =>
                    setValues((s) => ({ ...s, [key]: e.target.value }))
                  }
                  className="flex-1 rounded-lg border border-border-strong bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent-500 disabled:opacity-40"
                />
                {listId && (
                  <datalist id={listId}>
                    {opts.map((o) => (
                      <option key={o} value={o} />
                    ))}
                  </datalist>
                )}
              </div>
            );
          })}
        </div>

        <footer className="flex justify-end gap-3 border-t border-border px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-border-strong px-4 py-2 text-sm hover:border-border-strong"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={!anyEnabled}
            className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-medium hover:bg-accent-500 disabled:opacity-40"
          >
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}
