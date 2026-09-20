import { describe, expect, it } from "vitest";
import {
  gapIndexAt,
  reorderAt,
  addToPlaylist,
  movePlaylistItem,
  movePlaylistItems,
  playlistRows,
  removeFromPlaylist,
  stepPlaylistItem,
  uniquePlaylistName,
  wouldAdd,
} from "./playlists";
import type { Playlist } from "../types";

const A = "/lib/a.aiff";
const B = "/lib/b.aiff";
const C = "/lib/c.aiff";
const D = "/lib/d.aiff";

function playlist(name: string, id = 1): Playlist {
  return { id, name, created_ms: 0, updated_ms: 0, track_count: 0 };
}

describe("addToPlaylist", () => {
  it("appends, in the order given", () => {
    expect(addToPlaylist([A], [B, C])).toEqual([A, B, C]);
  });

  it("does not add a track that is already in the playlist", () => {
    // Twice in one playlist is a different feature; until something asks for
    // it, this is a no-op rather than a row nobody meant.
    expect(addToPlaylist([A, B], [B])).toEqual([A, B]);
    expect(addToPlaylist([A, B], [B, C])).toEqual([A, B, C]);
  });

  it("catches a duplicate inside the incoming selection too", () => {
    expect(addToPlaylist([], [A, A, B])).toEqual([A, B]);
  });

  it("returns the same list when there is nothing to add", () => {
    const current = [A, B];
    expect(addToPlaylist(current, [])).toBe(current);
    expect(addToPlaylist(current, [A])).toBe(current);
  });
});

describe("removeFromPlaylist", () => {
  it("takes out exactly what it was given", () => {
    expect(removeFromPlaylist([A, B, C], [B])).toEqual([A, C]);
    expect(removeFromPlaylist([A, B, C], [A, C])).toEqual([B]);
  });

  it("ignores a path that is not in the list", () => {
    expect(removeFromPlaylist([A], [B])).toEqual([A]);
  });
});

describe("movePlaylistItem", () => {
  it("moves a track to the index it should end up at", () => {
    expect(movePlaylistItem([A, B, C], 0, 2)).toEqual([B, C, A]);
    expect(movePlaylistItem([A, B, C], 2, 0)).toEqual([C, A, B]);
  });

  it("is move-up and move-down with a neighbouring index", () => {
    // One rule instead of three: the row menu and the drag produce the same
    // call.
    expect(movePlaylistItem([A, B, C], 1, 0)).toEqual([B, A, C]);
    expect(movePlaylistItem([A, B, C], 1, 2)).toEqual([A, C, B]);
  });

  it("does nothing where there is nothing to do", () => {
    const current = [A, B, C];
    // Move-up on the first row, move-down on the last, a drop outside the list:
    // all the same non-event.
    expect(movePlaylistItem(current, 0, -1)).toBe(current);
    expect(movePlaylistItem(current, 2, 3)).toBe(current);
    expect(movePlaylistItem(current, 1, 1)).toBe(current);
    expect(movePlaylistItem(current, 7, 0)).toBe(current);
  });
});

describe("movePlaylistItems", () => {
  it("moves a selection in front of a row", () => {
    expect(movePlaylistItems([A, B, C, D], [C, D], B)).toEqual([A, C, D, B]);
  });

  it("keeps the selection in the order it appears on screen", () => {
    // Not the order it was clicked in: what the user is dragging is what they
    // can see, and any other rule shuffles rows they never touched.
    expect(movePlaylistItems([A, B, C, D], [D, B], A)).toEqual([B, D, A, C]);
  });

  it("drops at the end when there is nothing to sit in front of", () => {
    expect(movePlaylistItems([A, B, C], [A], null)).toEqual([B, C, A]);
  });

  it("leaves the list alone when a selection is dropped on itself", () => {
    const current = [A, B, C];
    expect(movePlaylistItems(current, [B, C], C)).toBe(current);
  });

  it("ignores paths that are not in the playlist", () => {
    const current = [A, B];
    expect(movePlaylistItems(current, ["/elsewhere.aiff"], A)).toBe(current);
  });
});

describe("stepPlaylistItem", () => {
  it("moves a track one place, in both directions", () => {
    // Down is the one with the trap: the track is lifted out before it is put
    // back, so aiming at its neighbour would swap it with itself.
    expect(stepPlaylistItem([A, B, C], A, 1)).toEqual([B, A, C]);
    expect(stepPlaylistItem([A, B, C], B, 1)).toEqual([A, C, B]);
    expect(stepPlaylistItem([A, B, C], C, -1)).toEqual([A, C, B]);
    expect(stepPlaylistItem([A, B, C], B, -1)).toEqual([B, A, C]);
  });

  it("moves the last track down to nowhere, and the first up to nowhere", () => {
    const current = [A, B, C];
    expect(stepPlaylistItem(current, C, 1)).toBe(current);
    expect(stepPlaylistItem(current, A, -1)).toBe(current);
  });

  it("ignores a track that is not in the playlist", () => {
    const current = [A, B];
    expect(stepPlaylistItem(current, C, 1)).toBe(current);
  });

  it("agrees with the drag, which is the point of sharing its rule", () => {
    // One step down and a drag in front of the row after next are the same
    // move; if these two ever disagree, one of the two ways of reordering is
    // wrong and only one of them is tested.
    expect(stepPlaylistItem([A, B, C, D], A, 1)).toEqual(
      movePlaylistItems([A, B, C, D], [A], C),
    );
  });
});

describe("uniquePlaylistName", () => {
  it("keeps a name nobody is using", () => {
    expect(uniquePlaylistName([playlist("Warmup")], "Peak")).toBe("Peak");
  });

  it("counts up rather than offering the same name twice", () => {
    const existing = [playlist("Set", 1), playlist("Set 2", 2)];
    expect(uniquePlaylistName(existing, "Set")).toBe("Set 3");
  });

  it("does not care about case, because the user does not", () => {
    expect(uniquePlaylistName([playlist("set")], "Set")).toBe("Set 2");
  });

  it("falls back to a name at all", () => {
    expect(uniquePlaylistName([], "   ")).toBe("Playlist");
  });
});

describe("wouldAdd", () => {
  it("counts only what a playlist does not already hold", () => {
    // What the menu shows next to each entry, and what decides whether the
    // entry is clickable at all: offering a playlist that would gain nothing is
    // a click that does nothing.
    expect(wouldAdd([A], [A, B])).toBe(1);
    expect(wouldAdd([], [A, B])).toBe(2);
    expect(wouldAdd([A, B], [A, B])).toBe(0);
  });

  it("counts a repeated path once", () => {
    expect(wouldAdd([], [A, A])).toBe(1);
  });
});

describe("playlistRows", () => {
  const known = new Map([
    ["/lib/a.aiff", { title: "Alpha", artist: "One" }],
    ["/lib/b.aiff", { title: "Beta", artist: "Two" }],
  ]);

  it("numbers every stored entry, in the stored order", () => {
    const rows = playlistRows(["/lib/b.aiff", "/lib/a.aiff"], known);
    expect(rows.map((r) => [r.position, r.title])).toEqual([
      [1, "Beta"],
      [2, "Alpha"],
    ]);
    expect(rows.every((r) => !r.outsideLibrary)).toBe(true);
  });

  it("keeps an entry the loaded library has no row for, by its file name", () => {
    // `all_playlist_paths` reads every membership, `load_tracks` reads one
    // library folder — so this is a track that belongs to another one, which
    // the grouping skips and the dialog has to be able to show.
    const rows = playlistRows(["/lib/a.aiff", "/other/vanished.aiff"], known);
    expect(rows[1]).toMatchObject({
      position: 2,
      title: "vanished.aiff",
      artist: "",
      outsideLibrary: true,
    });
  });

  it("falls back to the whole path when there is no file name in it", () => {
    const rows = playlistRows(["weird"], known);
    expect(rows[0].title).toBe("weird");
  });

  it("has nothing to show for an empty playlist", () => {
    expect(playlistRows([], known)).toEqual([]);
  });
});

describe("gapIndexAt", () => {
  // Three 64 px rows, stacked from 100.
  const boxes = [0, 1, 2].map((i) => ({ top: 100 + i * 64, height: 64 }));

  it("counts gaps from the top, above the first being nought", () => {
    expect(gapIndexAt(boxes, 0)).toBe(0);
    expect(gapIndexAt(boxes, 110)).toBe(0);
  });

  it("crosses into the next gap at a row's midpoint", () => {
    expect(gapIndexAt(boxes, 131)).toBe(0);
    expect(gapIndexAt(boxes, 133)).toBe(1);
  });

  it("answers past the last row with the length", () => {
    expect(gapIndexAt(boxes, 9999)).toBe(3);
  });
});

describe("reorderAt", () => {
  const shown = ["a", "b", "c", "d"];

  it("moves a row up into the gap the pointer is in", () => {
    expect(reorderAt(shown, "c", 0)).toEqual(["c", "a", "b", "d"]);
    expect(reorderAt(shown, "c", 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("moves a row down to where it looks like it will land", () => {
    // The adjustment that matters: taking the row out shifts every gap below
    // it up by one, so without it a downward drag lands one row short.
    expect(reorderAt(shown, "a", 2)).toEqual(["b", "a", "c", "d"]);
    expect(reorderAt(shown, "a", 4)).toEqual(["b", "c", "d", "a"]);
  });

  it("leaves the order alone when the row is already in that gap", () => {
    expect(reorderAt(shown, "b", 1)).toEqual(shown);
    expect(reorderAt(shown, "b", 2)).toEqual(shown);
  });

  it("clamps a gap outside the list", () => {
    expect(reorderAt(shown, "b", 99)).toEqual(["a", "c", "d", "b"]);
    expect(reorderAt(shown, "b", -3)).toEqual(["b", "a", "c", "d"]);
  });

  it("shrugs at a path it does not hold", () => {
    expect(reorderAt(shown, "zz", 1)).toEqual(shown);
  });
});
