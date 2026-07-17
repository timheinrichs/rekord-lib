import { useState } from "react";
import type { TrackMetadata } from "../types";

/** Felder, die sich per Bulk-Edit setzen lassen. */
export type BulkPatch = Partial<
  Pick<TrackMetadata, "artist" | "album" | "album_artist" | "genre" | "year">
>;

interface Props {
  count: number;
  onClose: () => void;
  onApply: (patch: BulkPatch) => void;
}

type FieldKey = keyof BulkPatch;

const FIELDS: { key: FieldKey; label: string }[] = [
  { key: "album", label: "Album" },
  { key: "album_artist", label: "Album-Artist" },
  { key: "artist", label: "Artist" },
  { key: "genre", label: "Genre" },
  { key: "year", label: "Jahr" },
];

/**
 * Setzt ausgewählte Metadaten-Felder für mehrere Tracks gleichzeitig.
 * Nur angehakte Felder werden übernommen – leerer Wert löscht das Feld.
 */
export default function BulkMetadataEditor({ count, onClose, onApply }: Props) {
  const [enabled, setEnabled] = useState<Record<FieldKey, boolean>>({
    album: false,
    album_artist: false,
    artist: false,
    genre: false,
    year: false,
  });
  const [values, setValues] = useState<Record<FieldKey, string>>({
    album: "",
    album_artist: "",
    artist: "",
    genre: "",
    year: "",
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
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-neutral-800 bg-neutral-900 shadow-2xl">
        <header className="flex items-center justify-between border-b border-neutral-800 px-5 py-3">
          <h2 className="text-sm font-medium">
            Metadaten bearbeiten · {count} Titel
          </h2>
          <button
            onClick={onClose}
            className="text-neutral-400 hover:text-neutral-100"
          >
            ✕
          </button>
        </header>

        <div className="flex flex-col gap-3 p-5">
          <p className="text-xs text-neutral-500">
            Häkchen setzen, um ein Feld für alle ausgewählten Titel zu
            überschreiben. Leeres Feld entfernt den Wert.
          </p>
          {FIELDS.map(({ key, label }) => (
            <div key={key} className="flex items-center gap-3">
              <label className="flex w-32 shrink-0 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled[key]}
                  onChange={(e) =>
                    setEnabled((s) => ({ ...s, [key]: e.target.checked }))
                  }
                  className="h-4 w-4 rounded border-neutral-600 bg-neutral-800"
                />
                <span className={enabled[key] ? "text-neutral-200" : "text-neutral-500"}>
                  {label}
                </span>
              </label>
              <input
                value={values[key]}
                disabled={!enabled[key]}
                onChange={(e) =>
                  setValues((s) => ({ ...s, [key]: e.target.value }))
                }
                className="flex-1 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-sm outline-none focus:border-sky-500 disabled:opacity-40"
              />
            </div>
          ))}
        </div>

        <footer className="flex justify-end gap-3 border-t border-neutral-800 px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:border-neutral-500"
          >
            Abbrechen
          </button>
          <button
            onClick={handleApply}
            disabled={!anyEnabled}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-500 disabled:opacity-40"
          >
            Übernehmen
          </button>
        </footer>
      </div>
    </div>
  );
}
