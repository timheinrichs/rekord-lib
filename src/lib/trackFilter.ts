import type { TrackAnalysis } from "../types";
import { metaOf, type Edits } from "./grouping";

/** Where a track came from. Only Bandcamp is tracked; everything else is local. */
export type TrackSource = "bandcamp" | "local";

/**
 * The active filter. Every facet is "off" in its empty form, so `EMPTY_FILTER`
 * lets every track through. Facets combine with AND, values inside a facet
 * (genres, sources) with OR.
 */
export interface TrackFilter {
  bpmMin: number | null;
  bpmMax: number | null;
  /** Genre names as they appear in the tags; matched case-insensitively. */
  genres: string[];
  yearMin: number | null;
  yearMax: number | null;
  needsConvert: boolean;
  incompleteOnly: boolean;
  sources: TrackSource[];
}

export const EMPTY_FILTER: TrackFilter = {
  bpmMin: null,
  bpmMax: null,
  genres: [],
  yearMin: null,
  yearMax: null,
  needsConvert: false,
  incompleteOnly: false,
  sources: [],
};

/** A facet that can be switched off on its own (one chip = one facet). */
export type FilterFacet =
  | "bpm"
  | "genres"
  | "year"
  | "needsConvert"
  | "incompleteOnly"
  | "sources";

/**
 * What the pure functions cannot derive from a track alone: pending edits, the
 * edit-aware completeness rule, and the Bandcamp origin (which lives in a map
 * next to the library, not on the track).
 */
export interface FilterContext {
  edits: Edits;
  isIncomplete: (t: TrackAnalysis) => boolean;
  isFromBandcamp: (t: TrackAnalysis) => boolean;
}

/** One removable chip in the filter bar. */
export interface FilterChipSpec {
  facet: FilterFacet;
  label: string;
}

/** Tallies for the filter menu; computed once instead of per chip. */
export interface FilterCounts {
  total: number;
  needsConvert: number;
  incomplete: number;
  bandcamp: number;
  local: number;
}

/**
 * Year tags are free-form strings ("1998", "1998-05-01", "05/1998"), so the
 * first standalone run of exactly four digits is taken as the year. A longer
 * run (e.g. "19980501") is not a year and yields null.
 */
export function parseYear(raw: string | null): number | null {
  if (!raw) return null;
  const m = /(?:^|\D)(\d{4})(?:\D|$)/.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

/** Distinct genres present in the library, naturally sorted (for the menu). */
export function collectGenres(
  tracks: readonly TrackAnalysis[],
  edits: Edits,
): string[] {
  // Keyed by the lower-cased genre so "techno" and "Techno" collapse into one
  // entry, while the first spelling seen is what gets shown.
  const seen = new Map<string, string>();
  for (const t of tracks) {
    const g = metaOf(t, edits).genre?.trim();
    if (g && !seen.has(g.toLowerCase())) seen.set(g.toLowerCase(), g);
  }
  return [...seen.values()].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  );
}

export function isFilterActive(filter: TrackFilter): boolean {
  return (
    filter.bpmMin != null ||
    filter.bpmMax != null ||
    filter.genres.length > 0 ||
    filter.yearMin != null ||
    filter.yearMax != null ||
    filter.needsConvert ||
    filter.incompleteOnly ||
    filter.sources.length > 0
  );
}

/** "120–130", "from 120", "up to 130" — for a range that has at least one end. */
function rangeLabel(min: number | null, max: number | null): string {
  if (min != null && max != null) return `${min}–${max}`;
  if (min != null) return `from ${min}`;
  return `up to ${max}`;
}

/** One chip per active facet, in the order they appear in the menu. */
export function activeFilterChips(filter: TrackFilter): FilterChipSpec[] {
  const chips: FilterChipSpec[] = [];
  if (filter.bpmMin != null || filter.bpmMax != null) {
    chips.push({
      facet: "bpm",
      label: `BPM ${rangeLabel(filter.bpmMin, filter.bpmMax)}`,
    });
  }
  if (filter.genres.length) {
    chips.push({ facet: "genres", label: `Genre: ${filter.genres.join(", ")}` });
  }
  if (filter.yearMin != null || filter.yearMax != null) {
    chips.push({
      facet: "year",
      label: `Year ${rangeLabel(filter.yearMin, filter.yearMax)}`,
    });
  }
  if (filter.needsConvert) {
    chips.push({ facet: "needsConvert", label: "To convert" });
  }
  if (filter.incompleteOnly) {
    chips.push({ facet: "incompleteOnly", label: "Metadata incomplete" });
  }
  if (filter.sources.length) {
    const names = filter.sources.map((s) =>
      s === "bandcamp" ? "Bandcamp" : "Local",
    );
    chips.push({ facet: "sources", label: `Source: ${names.join(", ")}` });
  }
  return chips;
}

/** Switches a single facet off, leaving the rest of the filter untouched. */
export function clearFacet(filter: TrackFilter, facet: FilterFacet): TrackFilter {
  switch (facet) {
    case "bpm":
      return { ...filter, bpmMin: null, bpmMax: null };
    case "genres":
      return { ...filter, genres: [] };
    case "year":
      return { ...filter, yearMin: null, yearMax: null };
    case "needsConvert":
      return { ...filter, needsConvert: false };
    case "incompleteOnly":
      return { ...filter, incompleteOnly: false };
    default:
      return { ...filter, sources: [] };
  }
}

/** Is the value inside the (possibly half-open) range? Missing value = no. */
function inRange(
  value: number | null,
  min: number | null,
  max: number | null,
): boolean {
  if (min == null && max == null) return true;
  // A track that carries no tempo or no year cannot satisfy a range — leaving
  // it in would make "120–130 BPM" show untagged files.
  if (value == null) return false;
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

export function matchesFilter(
  t: TrackAnalysis,
  filter: TrackFilter,
  ctx: FilterContext,
): boolean {
  const md = metaOf(t, ctx.edits);
  if (filter.needsConvert && t.compat.compatible) return false;
  if (filter.incompleteOnly && !ctx.isIncomplete(t)) return false;
  if (!inRange(md.bpm, filter.bpmMin, filter.bpmMax)) return false;
  if (!inRange(parseYear(md.year), filter.yearMin, filter.yearMax)) return false;
  if (filter.genres.length) {
    const g = md.genre?.trim().toLowerCase();
    if (!g || !filter.genres.some((x) => x.trim().toLowerCase() === g)) {
      return false;
    }
  }
  if (filter.sources.length) {
    const source: TrackSource = ctx.isFromBandcamp(t) ? "bandcamp" : "local";
    if (!filter.sources.includes(source)) return false;
  }
  return true;
}

/**
 * Free-text match over the fields a user would search by. Edit-aware, so a
 * pending (not yet written) title is found just like a saved one.
 */
export function matchesSearch(
  t: TrackAnalysis,
  query: string,
  edits: Edits,
): boolean {
  if (!query) return true;
  const md = metaOf(t, edits);
  const hay = [
    md.title,
    md.artist,
    md.album,
    md.album_artist,
    md.label,
    md.genre,
    md.year,
    t.file_name,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(query);
}

/** The visible tracks: filter facets AND free-text search. Pure. */
export function filterTracks(
  tracks: readonly TrackAnalysis[],
  filter: TrackFilter,
  search: string,
  ctx: FilterContext,
): TrackAnalysis[] {
  const q = search.trim().toLowerCase();
  // Nothing to do — hand back a plain copy rather than walking every track.
  if (!q && !isFilterActive(filter)) return [...tracks];
  return tracks.filter(
    (t) => matchesFilter(t, filter, ctx) && matchesSearch(t, q, ctx.edits),
  );
}

/** Counts for the whole library (the menu shows what a facet would yield). */
export function filterCounts(
  tracks: readonly TrackAnalysis[],
  ctx: FilterContext,
): FilterCounts {
  let needsConvert = 0;
  let incomplete = 0;
  let bandcamp = 0;
  for (const t of tracks) {
    if (!t.compat.compatible) needsConvert++;
    if (ctx.isIncomplete(t)) incomplete++;
    if (ctx.isFromBandcamp(t)) bandcamp++;
  }
  return {
    total: tracks.length,
    needsConvert,
    incomplete,
    bandcamp,
    local: tracks.length - bandcamp,
  };
}
