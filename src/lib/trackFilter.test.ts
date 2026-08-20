import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER,
  activeFilterChips,
  clearFacet,
  collectGenres,
  collectKeys,
  filterCounts,
  filterTracks,
  isFilterActive,
  matchesFilter,
  matchesSearch,
  parseYear,
  type FilterContext,
  type TrackFilter,
} from "./trackFilter";
import { makeCompat, makeMetadata, makeTrack } from "../test/factories";
import type { TrackAnalysis } from "../types";

/** Context with no edits, no Bandcamp origin and the plain incomplete flag. */
function ctx(over: Partial<FilterContext> = {}): FilterContext {
  return {
    edits: {},
    isIncomplete: (t) => t.metadata_incomplete,
    isFromBandcamp: () => false,
    ...over,
  };
}

function filter(over: Partial<TrackFilter> = {}): TrackFilter {
  return { ...EMPTY_FILTER, ...over };
}

const techno = makeTrack({
  id: "techno",
  path: "/music/a/techno.aiff",
  metadata: makeMetadata({
    title: "Rave",
    genre: "Techno",
    year: "2020",
    bpm: 130,
  }),
});
const house = makeTrack({
  id: "house",
  path: "/music/b/house.aiff",
  metadata: makeMetadata({
    title: "Groove",
    genre: "House",
    year: "2010",
    bpm: 122,
  }),
});
const untagged = makeTrack({
  id: "untagged",
  path: "/music/c/untagged.wav",
  metadata: makeMetadata({ title: "Blank", genre: null, year: null, bpm: null }),
});
const all = [techno, house, untagged];

function ids(tracks: TrackAnalysis[]): string[] {
  return tracks.map((t) => t.id);
}

describe("parseYear", () => {
  it("reads a plain year and a date", () => {
    expect(parseYear("1998")).toBe(1998);
    expect(parseYear("1998-05-01")).toBe(1998);
    expect(parseYear("05/1998")).toBe(1998);
    expect(parseYear("  2024 ")).toBe(2024);
  });

  it("returns null for anything that is not a four-digit year", () => {
    expect(parseYear(null)).toBeNull();
    expect(parseYear("")).toBeNull();
    expect(parseYear("unknown")).toBeNull();
    expect(parseYear("98")).toBeNull();
    // A run of eight digits is a packed date, not a year.
    expect(parseYear("19980501")).toBeNull();
  });
});

describe("collectGenres", () => {
  it("returns distinct genres, sorted, ignoring case and blanks", () => {
    const extra = makeTrack({
      id: "x",
      metadata: makeMetadata({ genre: "techno" }),
    });
    const blank = makeTrack({
      id: "y",
      metadata: makeMetadata({ genre: "   " }),
    });
    expect(collectGenres([...all, extra, blank], {})).toEqual([
      "House",
      "Techno",
    ]);
  });

  it("prefers pending edits over the scanned tag", () => {
    const edits = {
      techno: { metadata: makeMetadata({ genre: "Ambient" }), cover: null },
    } as unknown as FilterContext["edits"];
    expect(collectGenres([techno], edits)).toEqual(["Ambient"]);
  });
});

describe("isFilterActive", () => {
  it("is false for the empty filter", () => {
    expect(isFilterActive(EMPTY_FILTER)).toBe(false);
  });

  it("is true for every single facet", () => {
    expect(isFilterActive(filter({ bpmMin: 100 }))).toBe(true);
    expect(isFilterActive(filter({ bpmMax: 100 }))).toBe(true);
    expect(isFilterActive(filter({ genres: ["Techno"] }))).toBe(true);
    expect(isFilterActive(filter({ yearMin: 2000 }))).toBe(true);
    expect(isFilterActive(filter({ yearMax: 2000 }))).toBe(true);
    expect(isFilterActive(filter({ needsConvert: true }))).toBe(true);
    expect(isFilterActive(filter({ incompleteOnly: true }))).toBe(true);
    expect(isFilterActive(filter({ sources: ["bandcamp"] }))).toBe(true);
  });
});

describe("filterTracks", () => {
  it("lets everything through when nothing is set", () => {
    expect(ids(filterTracks(all, EMPTY_FILTER, "", ctx()))).toEqual([
      "techno",
      "house",
      "untagged",
    ]);
  });

  it("returns a copy, not the input array", () => {
    const out = filterTracks(all, EMPTY_FILTER, "", ctx());
    expect(out).not.toBe(all);
    expect(out).toEqual(all);
  });

  it("filters by a closed BPM range and drops tracks without a tempo", () => {
    const out = filterTracks(all, filter({ bpmMin: 125, bpmMax: 135 }), "", ctx());
    expect(ids(out)).toEqual(["techno"]);
  });

  it("supports half-open BPM ranges", () => {
    expect(ids(filterTracks(all, filter({ bpmMin: 125 }), "", ctx()))).toEqual([
      "techno",
    ]);
    expect(ids(filterTracks(all, filter({ bpmMax: 125 }), "", ctx()))).toEqual([
      "house",
    ]);
  });

  it("includes the range bounds", () => {
    const out = filterTracks(all, filter({ bpmMin: 122, bpmMax: 130 }), "", ctx());
    expect(ids(out)).toEqual(["techno", "house"]);
  });

  it("filters by year and drops tracks without a parsable year", () => {
    const out = filterTracks(all, filter({ yearMin: 2015 }), "", ctx());
    expect(ids(out)).toEqual(["techno"]);
  });

  it("matches genres case-insensitively and ORs several of them", () => {
    expect(
      ids(filterTracks(all, filter({ genres: ["techno"] }), "", ctx())),
    ).toEqual(["techno"]);
    expect(
      ids(filterTracks(all, filter({ genres: ["Techno", "House"] }), "", ctx())),
    ).toEqual(["techno", "house"]);
  });

  it("filters by conversion need", () => {
    const bad = makeTrack({
      id: "bad",
      compat: makeCompat({ compatible: false }),
    });
    const out = filterTracks(
      [...all, bad],
      filter({ needsConvert: true }),
      "",
      ctx(),
    );
    expect(ids(out)).toEqual(["bad"]);
  });

  it("filters by incomplete metadata using the injected rule", () => {
    const out = filterTracks(all, filter({ incompleteOnly: true }), "", {
      ...ctx(),
      isIncomplete: (t) => t.id === "house",
    });
    expect(ids(out)).toEqual(["house"]);
  });

  it("filters by source in both directions", () => {
    const withOrigin = ctx({ isFromBandcamp: (t) => t.id === "techno" });
    expect(
      ids(filterTracks(all, filter({ sources: ["bandcamp"] }), "", withOrigin)),
    ).toEqual(["techno"]);
    expect(
      ids(filterTracks(all, filter({ sources: ["local"] }), "", withOrigin)),
    ).toEqual(["house", "untagged"]);
    expect(
      ids(
        filterTracks(
          all,
          filter({ sources: ["bandcamp", "local"] }),
          "",
          withOrigin,
        ),
      ),
    ).toEqual(["techno", "house", "untagged"]);
  });

  it("combines facets with AND", () => {
    const out = filterTracks(
      all,
      filter({ genres: ["Techno", "House"], bpmMax: 125 }),
      "",
      ctx(),
    );
    expect(ids(out)).toEqual(["house"]);
  });

  it("applies the search on top of the filter", () => {
    const out = filterTracks(all, filter({ bpmMin: 100 }), "groove", ctx());
    expect(ids(out)).toEqual(["house"]);
  });
});

describe("matchesSearch", () => {
  it("matches an empty query", () => {
    expect(matchesSearch(techno, "", {})).toBe(true);
  });

  it("searches title, genre, year and file name", () => {
    expect(matchesSearch(techno, "rave", {})).toBe(true);
    expect(matchesSearch(techno, "techno", {})).toBe(true);
    expect(matchesSearch(techno, "2020", {})).toBe(true);
    expect(matchesSearch(techno, "techno.aiff", {})).toBe(true);
    expect(matchesSearch(techno, "nope", {})).toBe(false);
  });

  it("sees pending edits", () => {
    const edits = {
      techno: { metadata: makeMetadata({ title: "Renamed" }), cover: null },
    } as unknown as FilterContext["edits"];
    expect(matchesSearch(techno, "renamed", edits)).toBe(true);
    expect(matchesSearch(techno, "rave", edits)).toBe(false);
  });
});

describe("activeFilterChips", () => {
  it("returns nothing for the empty filter", () => {
    expect(activeFilterChips(EMPTY_FILTER)).toEqual([]);
  });

  it("labels closed and half-open ranges", () => {
    expect(activeFilterChips(filter({ bpmMin: 120, bpmMax: 130 }))[0].label).toBe(
      "BPM 120–130",
    );
    expect(activeFilterChips(filter({ bpmMin: 120 }))[0].label).toBe(
      "BPM from 120",
    );
    expect(activeFilterChips(filter({ bpmMax: 130 }))[0].label).toBe(
      "BPM up to 130",
    );
    expect(activeFilterChips(filter({ yearMin: 2020 }))[0].label).toBe(
      "Year from 2020",
    );
  });

  it("joins multi-value facets and names the sources", () => {
    expect(
      activeFilterChips(filter({ genres: ["Techno", "House"] }))[0].label,
    ).toBe("Genre: Techno, House");
    expect(activeFilterChips(filter({ sources: ["bandcamp"] }))[0].label).toBe(
      "Source: Bandcamp",
    );
    expect(activeFilterChips(filter({ sources: ["local"] }))[0].label).toBe(
      "Source: Local",
    );
  });

  it("returns one chip per active facet", () => {
    const chips = activeFilterChips(
      filter({
        bpmMin: 120,
        genres: ["Techno"],
        yearMax: 2020,
        needsConvert: true,
        incompleteOnly: true,
        sources: ["bandcamp"],
      }),
    );
    expect(chips.map((c) => c.facet)).toEqual([
      "bpm",
      "genres",
      "year",
      "needsConvert",
      "incompleteOnly",
      "sources",
    ]);
  });
});

describe("clearFacet", () => {
  const full = filter({
    bpmMin: 120,
    bpmMax: 130,
    genres: ["Techno"],
    yearMin: 2000,
    yearMax: 2020,
    needsConvert: true,
    incompleteOnly: true,
    sources: ["bandcamp"],
  });

  it("clears both ends of a range facet", () => {
    expect(clearFacet(full, "bpm")).toMatchObject({ bpmMin: null, bpmMax: null });
    expect(clearFacet(full, "year")).toMatchObject({
      yearMin: null,
      yearMax: null,
    });
  });

  it("clears one facet and leaves the others alone", () => {
    const out = clearFacet(full, "genres");
    expect(out.genres).toEqual([]);
    expect(out.bpmMin).toBe(120);
    expect(out.needsConvert).toBe(true);
  });

  it("clearing every facet ends at the empty filter", () => {
    const facets = [
      "bpm",
      "genres",
      "year",
      "needsConvert",
      "incompleteOnly",
      "sources",
    ] as const;
    const out = facets.reduce((f, facet) => clearFacet(f, facet), full);
    expect(out).toEqual(EMPTY_FILTER);
    expect(isFilterActive(out)).toBe(false);
  });

  it("does not mutate the input", () => {
    clearFacet(full, "bpm");
    expect(full.bpmMin).toBe(120);
  });
});

describe("filterCounts", () => {
  it("counts each facet over the whole library", () => {
    const bad = makeTrack({
      id: "bad",
      compat: makeCompat({ compatible: false }),
      metadata_incomplete: true,
    });
    const counts = filterCounts([...all, bad], {
      ...ctx(),
      isFromBandcamp: (t) => t.id === "techno",
    });
    expect(counts).toEqual({
      total: 4,
      needsConvert: 1,
      incomplete: 1,
      bandcamp: 1,
      local: 3,
    });
  });

  it("handles an empty library", () => {
    expect(filterCounts([], ctx())).toEqual({
      total: 0,
      needsConvert: 0,
      incomplete: 0,
      bandcamp: 0,
      local: 0,
    });
  });
});

describe("collectKeys", () => {
  const keyed = (id: string, key: string | null, camelot: string | null) =>
    makeTrack({ id, path: `/lib/${id}.aiff`, key, key_camelot: camelot });

  it("lists keys in Camelot order, not alphabetically", () => {
    // The whole point: neighbours on the wheel are neighbours in the menu, so
    // picking two mixable keys means picking two adjacent entries. Alphabetical
    // would put A#m beside Am and eleven steps from what it mixes with.
    const tracks = [
      keyed("a", "Am", "8A"),
      keyed("b", "Em", "9A"),
      keyed("c", "C", "8B"),
      keyed("d", "Abm", "1A"),
    ];
    expect(collectKeys(tracks)).toEqual(["Abm", "Am", "C", "Em"]);
  });

  it("collapses duplicates and skips tracks without a key", () => {
    const tracks = [
      keyed("a", "Am", "8A"),
      keyed("b", "Am", "8A"),
      keyed("c", null, null),
      keyed("d", "  ", null),
    ];
    expect(collectKeys(tracks)).toEqual(["Am"]);
  });

  it("puts a key with no usable Camelot last rather than in the middle", () => {
    // A row from an older database has no derived Camelot; it must not land at a
    // random spot among the real keys.
    const tracks = [
      keyed("a", "Weird", null),
      keyed("b", "Am", "8A"),
      keyed("c", "Em", "9A"),
    ];
    expect(collectKeys(tracks)).toEqual(["Am", "Em", "Weird"]);
  });

  it("is empty for a library that has not been analysed", () => {
    expect(collectKeys([])).toEqual([]);
    expect(collectKeys([keyed("a", null, null)])).toEqual([]);
  });
});

describe("the key facet", () => {
  const ctx = {
    edits: {},
    isIncomplete: () => false,
    isFromBandcamp: () => false,
  };
  const keyed = (key: string | null) => makeTrack({ key, key_camelot: null });

  it("keeps only the selected keys", () => {
    const filter = { ...EMPTY_FILTER, keys: ["Am", "C"] };
    expect(matchesFilter(keyed("Am"), filter, ctx)).toBe(true);
    expect(matchesFilter(keyed("C"), filter, ctx)).toBe(true);
    expect(matchesFilter(keyed("Em"), filter, ctx)).toBe(false);
  });

  it("excludes tracks with no key, like the other facets do", () => {
    // Leaving them in would make "Key: Am" show unanalysed files.
    const filter = { ...EMPTY_FILTER, keys: ["Am"] };
    expect(matchesFilter(keyed(null), filter, ctx)).toBe(false);
  });

  it("matches regardless of spelling case", () => {
    const filter = { ...EMPTY_FILTER, keys: ["am"] };
    expect(matchesFilter(keyed("Am"), filter, ctx)).toBe(true);
  });

  it("counts as active and clears on its own", () => {
    const filter = { ...EMPTY_FILTER, keys: ["Am"], needsConvert: true };
    expect(isFilterActive(filter)).toBe(true);
    expect(activeFilterChips(filter).map((c) => c.facet)).toContain("keys");
    expect(activeFilterChips(filter).find((c) => c.facet === "keys")?.label).toBe(
      "Key: Am",
    );
    // Clearing the key must leave the other facet alone.
    const cleared = clearFacet(filter, "keys");
    expect(cleared.keys).toEqual([]);
    expect(cleared.needsConvert).toBe(true);
  });
});
