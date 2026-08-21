import { describe, expect, it } from "vitest";
import {
  addToPlaylist,
  movePlaylistItem,
  movePlaylistItems,
  removeFromPlaylist,
  uniquePlaylistName,
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
