import { describe, expect, it } from "vitest";
import {
  COLUMNS,
  columnLabel,
  hideableColumns,
  toggleColumn,
  visibleColumns,
  type ColumnId,
} from "./columns";

describe("COLUMNS", () => {
  it("is in the order the table shows", () => {
    // Asserted as a list because the order *is* the spec: the header, the group
    // rows and the track rows all iterate this, so getting it wrong here is the
    // only way they can disagree.
    expect(COLUMNS.map((c) => c.id)).toEqual([
      "select",
      "expand",
      "cover",
      "waveform",
      "title",
      "artist",
      "album",
      "length",
      "bpm",
      "key",
      "format",
      "downloaded",
      "status",
      "actions",
    ]);
  });

  it("gives exactly one column no width", () => {
    // The one without a width absorbs the slack. Two would fight over it, none
    // would leave the table narrower than its container.
    const flexible = COLUMNS.filter((c) => !c.width);
    expect(flexible.map((c) => c.id)).toEqual(["title"]);
  });

  it("has no duplicate ids", () => {
    expect(new Set(COLUMNS.map((c) => c.id)).size).toBe(COLUMNS.length);
  });
});

describe("icon columns", () => {
  it("marks the narrow ones as tight", () => {
    // `w-8` with the table's usual `px-4` is 32 px of padding in a 32 px cell:
    // a content box of zero, which is where the expand chevron went when it
    // moved out of the flexible title cell.
    const expand = COLUMNS.find((c) => c.id === "expand");
    expect(expand?.tight).toBe(true);
    // A column with text must not be tight, or the label loses its gutter.
    expect(COLUMNS.filter((c) => c.tight).every((c) => c.label === "")).toBe(true);
  });
});

describe("visibleColumns", () => {
  it("shows everything by default", () => {
    expect(visibleColumns([])).toEqual(COLUMNS);
  });

  it("drops what was switched off, keeping the order", () => {
    const ids = visibleColumns(["album", "format"]).map((c) => c.id);
    expect(ids).not.toContain("album");
    expect(ids).not.toContain("format");
    // Still in display order, not the order they were toggled in.
    expect(ids.indexOf("title")).toBeLessThan(ids.indexOf("artist"));
  });

  it("keeps a fixed column even when a stale setting names it", () => {
    // A hand-edited store must not produce a list with no checkboxes and no
    // way to expand a group.
    const ids = visibleColumns(["select", "expand", "title", "actions"]).map(
      (c) => c.id,
    );
    expect(ids).toContain("select");
    expect(ids).toContain("expand");
    expect(ids).toContain("title");
    expect(ids).toContain("actions");
  });

  it("ignores an unknown id", () => {
    // A setting written by a later version, opened by an earlier one.
    expect(visibleColumns(["nonsense" as ColumnId])).toEqual(COLUMNS);
  });
});

describe("toggleColumn", () => {
  it("switches a column off and on again", () => {
    const once = toggleColumn([], "album");
    expect(once).toEqual(["album"]);
    expect(toggleColumn(once, "album")).toEqual([]);
  });

  it("leaves the others alone", () => {
    expect(toggleColumn(["album"], "format")).toEqual(["album", "format"]);
  });

  it("refuses to switch off a fixed column", () => {
    expect(toggleColumn([], "select")).toEqual([]);
    expect(toggleColumn([], "title")).toEqual([]);
  });

  it("does not mutate what it was given", () => {
    const hidden: ColumnId[] = ["album"];
    toggleColumn(hidden, "format");
    expect(hidden).toEqual(["album"]);
  });
});

describe("hideableColumns", () => {
  it("offers every column that is not needed to operate the table", () => {
    const ids = hideableColumns().map((c) => c.id);
    expect(ids).not.toContain("select");
    expect(ids).not.toContain("expand");
    expect(ids).not.toContain("title");
    expect(ids).not.toContain("actions");
    expect(ids).toContain("waveform");
    expect(ids).toContain("bpm");
    expect(ids).toContain("key");
  });
});

describe("columnLabel", () => {
  it("uses the header text where there is one", () => {
    expect(columnLabel({ id: "bpm", label: "BPM" })).toBe("BPM");
  });

  it("names the columns that carry no header", () => {
    // Otherwise the menu would show a checkbox with nothing beside it.
    expect(columnLabel({ id: "cover", label: "" })).toBe("Cover");
    expect(columnLabel({ id: "waveform", label: "" })).toBe("Waveform");
  });
});
