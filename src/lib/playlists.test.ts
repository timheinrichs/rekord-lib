import { describe, expect, it } from "vitest";
import {
  addToPlaylist,
  buildPlaylistGroups,
  UNSORTED_ID,
  movePlaylistItem,
  movePlaylistItems,
  removeFromPlaylist,
  stepPlaylistItem,
  uniquePlaylistName,
  wouldAdd,
} from "./playlists";
import { makeTrack } from "../test/factories";
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

describe("buildPlaylistGroups", () => {
  const tracks = [A, B, C].map((path) => makeTrack({ path, id: path }));

  it("puts the tracks in the playlist's order, not the table's", () => {
    // The order is the content. Every other grouping sorts its rows; this one
    // must not, which is also why the position is worth a column.
    const groups = buildPlaylistGroups(
      [playlist("Warmup", 1)],
      { 1: [C, A] },
      tracks,
    );
    expect(groups[0].tracks.map((t) => t.path)).toEqual([C, A]);
  });

  it("collects what is in no playlist, and says so even when empty", () => {
    // It is where a track lands when it is taken out of a playlist. A bucket
    // that appears only sometimes is one nobody learns to look in.
    const groups = buildPlaylistGroups([playlist("Set", 1)], { 1: [A] }, tracks);
    const unsorted = groups[groups.length - 1];
    expect(unsorted.id).toBe(UNSORTED_ID);
    expect(unsorted.tracks.map((t) => t.path)).toEqual([B, C]);

    const all = buildPlaylistGroups([playlist("Set", 1)], { 1: [A, B, C] }, tracks);
    expect(all[all.length - 1].tracks).toEqual([]);
  });

  it("skips a path with no track on screen", () => {
    // Filtered out, or the file is gone and the row already pruned. Either way
    // there is nothing to draw, and the count follows what is visible.
    const groups = buildPlaylistGroups(
      [playlist("Set", 1)],
      { 1: [A, "/lib/vanished.aiff", B] },
      tracks,
    );
    expect(groups[0].tracks.map((t) => t.path)).toEqual([A, B]);
  });

  it("keeps a track that is in two playlists in both", () => {
    const groups = buildPlaylistGroups(
      [playlist("One", 1), playlist("Two", 2)],
      { 1: [A], 2: [A, B] },
      tracks,
    );
    expect(groups[0].tracks.map((t) => t.path)).toEqual([A]);
    expect(groups[1].tracks.map((t) => t.path)).toEqual([A, B]);
    // And out of the unsorted bucket, which asks "in *any* playlist".
    expect(groups[2].tracks.map((t) => t.path)).toEqual([C]);
  });

  it("is just the unsorted bucket when there are no playlists", () => {
    const groups = buildPlaylistGroups([], {}, tracks);
    expect(groups).toHaveLength(1);
    expect(groups[0].tracks).toHaveLength(3);
  });
});
