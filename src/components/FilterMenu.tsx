import { useState } from "react";
import { useDismiss } from "../lib/useDismiss";
import { FilterIcon } from "./icons";
import {
  EMPTY_FILTER,
  isFilterActive,
  type FilterCounts,
  type TrackFilter,
  type TrackSource,
} from "../lib/trackFilter";

interface Props {
  filter: TrackFilter;
  onChange: (next: TrackFilter) => void;
  /** Genres present in the library (the only ones worth offering). */
  genres: string[];
  /** Detected keys present in the library, already in Camelot order. */
  keys: string[];
  counts: FilterCounts;
}

/**
 * Filter popover next to the grouping switch: BPM and year ranges, genre,
 * status and origin. Fully controlled — it owns nothing but its open state.
 */
export default function FilterMenu({
  filter,
  onChange,
  genres,
  keys,
  counts,
}: Props) {
  const [open, setOpen] = useState(false);
  // Wraps the button too, so the press that closes the popover is not read as
  // a press on the button (which would reopen it).
  const ref = useDismiss<HTMLDivElement>(open, () => setOpen(false));
  const active = isFilterActive(filter);

  const patch = (p: Partial<TrackFilter>) => onChange({ ...filter, ...p });

  const toggleGenre = (genre: string) =>
    patch({
      genres: filter.genres.includes(genre)
        ? filter.genres.filter((g) => g !== genre)
        : [...filter.genres, genre],
    });

  const toggleKey = (key: string) =>
    patch({
      keys: filter.keys.includes(key)
        ? filter.keys.filter((k) => k !== key)
        : [...filter.keys, key],
    });

  const toggleSource = (source: TrackSource) =>
    patch({
      sources: filter.sources.includes(source)
        ? filter.sources.filter((s) => s !== source)
        : [...filter.sources, source],
    });

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`relative flex h-9 w-9 items-center justify-center rounded-md border transition-colors ${
          open || active
            ? "border-accent-500 text-accent-400"
            : "border-border-strong text-fg-muted hover:border-accent-500 hover:text-accent-400"
        }`}
        title="Filter tracks"
        aria-label="Filter tracks"
        aria-expanded={open}
      >
        <FilterIcon />
        {active && (
          <span
            className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-accent-500"
            aria-hidden="true"
          />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-80 rounded-lg border border-border bg-surface p-4 shadow-md">
          <div className="flex flex-col gap-4">
            <Section label="BPM">
              <RangeInputs
                min={filter.bpmMin}
                max={filter.bpmMax}
                onMin={(bpmMin) => patch({ bpmMin })}
                onMax={(bpmMax) => patch({ bpmMax })}
                minLabel="Minimum BPM"
                maxLabel="Maximum BPM"
              />
            </Section>

            <Section label="Key">
              {keys.length === 0 ? (
                <p className="font-sans text-xs text-fg-subtle">
                  No keys detected yet — the scan fills these in.
                </p>
              ) : (
                <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                  {keys.map((k) => (
                    <Check
                      key={k}
                      label={k}
                      checked={filter.keys.includes(k)}
                      onChange={() => toggleKey(k)}
                    />
                  ))}
                </div>
              )}
            </Section>
            <Section label="Year">
              <RangeInputs
                min={filter.yearMin}
                max={filter.yearMax}
                onMin={(yearMin) => patch({ yearMin })}
                onMax={(yearMax) => patch({ yearMax })}
                minLabel="Earliest year"
                maxLabel="Latest year"
              />
            </Section>

            <Section label="Genre">
              {genres.length === 0 ? (
                <p className="font-sans text-xs text-fg-subtle">
                  No genres tagged yet.
                </p>
              ) : (
                <div className="max-h-40 overflow-y-auto rounded-md border border-border">
                  {genres.map((g) => (
                    <Check
                      key={g}
                      label={g}
                      checked={filter.genres.includes(g)}
                      onChange={() => toggleGenre(g)}
                    />
                  ))}
                </div>
              )}
            </Section>

            <Section label="Status">
              <Check
                label="To convert"
                count={counts.needsConvert}
                checked={filter.needsConvert}
                onChange={() => patch({ needsConvert: !filter.needsConvert })}
              />
              <Check
                label="Metadata incomplete"
                count={counts.incomplete}
                checked={filter.incompleteOnly}
                onChange={() =>
                  patch({ incompleteOnly: !filter.incompleteOnly })
                }
              />
            </Section>

            <Section label="Source">
              <Check
                label="Bandcamp"
                count={counts.bandcamp}
                checked={filter.sources.includes("bandcamp")}
                onChange={() => toggleSource("bandcamp")}
              />
              <Check
                label="Local"
                count={counts.local}
                checked={filter.sources.includes("local")}
                onChange={() => toggleSource("local")}
              />
            </Section>

            <button
              onClick={() => onChange(EMPTY_FILTER)}
              disabled={!active}
              className="rounded-md border border-border-strong px-3 py-2 text-sm text-fg-muted transition-colors enabled:hover:border-accent-500 enabled:hover:text-fg disabled:border-border disabled:text-fg-disabled disabled:enabled:hover:border-border-strong disabled:enabled:hover:text-fg-muted"
            >
              Reset all
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-fg-muted">{label}</span>
      {children}
    </div>
  );
}

/** Two optional number inputs forming a (possibly half-open) range. */
function RangeInputs({
  min,
  max,
  onMin,
  onMax,
  minLabel,
  maxLabel,
}: {
  min: number | null;
  max: number | null;
  onMin: (v: number | null) => void;
  onMax: (v: number | null) => void;
  minLabel: string;
  maxLabel: string;
}) {
  // An empty field means "no bound", which is not the same as 0.
  const parse = (raw: string) => (raw.trim() === "" ? null : Number(raw));
  const cls =
    "w-full rounded-md border border-border-strong bg-surface-2 px-2 py-1.5 text-sm outline-none focus:border-accent-500";
  return (
    <div className="flex items-center gap-2">
      <input
        type="number"
        value={min ?? ""}
        onChange={(e) => onMin(parse(e.target.value))}
        placeholder="Min"
        aria-label={minLabel}
        className={cls}
      />
      <span className="text-fg-subtle">–</span>
      <input
        type="number"
        value={max ?? ""}
        onChange={(e) => onMax(parse(e.target.value))}
        placeholder="Max"
        aria-label={maxLabel}
        className={cls}
      />
    </div>
  );
}

function Check({
  label,
  count,
  checked,
  onChange,
}: {
  label: string;
  count?: number;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm hover:bg-surface-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 shrink-0 rounded border-border-strong bg-surface-2"
      />
      <span className="min-w-0 flex-1 truncate text-fg">{label}</span>
      {count != null && <span className="text-xs text-fg-subtle">{count}</span>}
    </label>
  );
}
