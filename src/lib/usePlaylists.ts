import { useCallback, useEffect, useState } from "react";
import {
  createPlaylist,
  deletePlaylist,
  loadPlaylistContents,
  loadPlaylists,
  renamePlaylist,
  setPlaylistPaths,
} from "./api";
import {
  addToPlaylist,
  movePlaylistItems,
  removeFromPlaylist,
  stepPlaylistItem,
  uniquePlaylistName,
} from "./playlists";
import type { Playlist } from "../types";

/**
 * The playlists, and every way the library view changes them.
 *
 * A hook rather than state inside `LibraryView` for the same reason
 * `useBandcamp` is one: the view is long enough already, and every operation
 * here is the same three steps — work out the new list with the pure functions
 * in `lib/playlists.ts`, write it, re-read. Keeping those three in one place is
 * what stops a caller from doing two of them.
 *
 * **Optimistic, then reconciled.** The new order is applied locally before the
 * write returns, because a drag that snaps back for a moment reads as a failed
 * drag. The re-read afterwards is what makes the screen agree with the database
 * again — including when the database refused part of it, which it does for a
 * path the library no longer holds.
 */
export interface Playlists {
  all: Playlist[];
  /** Paths per playlist id, in playlist order. */
  contents: Record<number, string[]>;
  /** Whether the first load has happened, so the UI can tell empty from unread. */
  loaded: boolean;
  create: (name: string) => Promise<number | null>;
  rename: (id: number, name: string) => Promise<void>;
  remove: (id: number) => Promise<void>;
  /** Appends tracks that are not in the playlist yet. */
  add: (id: number, paths: string[]) => Promise<void>;
  /** Takes tracks out of one playlist. */
  removeTracks: (id: number, paths: string[]) => Promise<void>;
  /** Moves `paths` in front of `before` (`null` = to the end). */
  move: (id: number, paths: string[], before: string | null) => Promise<void>;
  /** Moves one track one place up (`-1`) or down (`1`). */
  step: (id: number, path: string, step: -1 | 1) => Promise<void>;
  /** A name that is not taken yet, for the "new playlist" default. */
  suggestName: (base: string) => string;
  reload: () => Promise<void>;
}

export function usePlaylists(): Playlists {
  const [all, setAll] = useState<Playlist[]>([]);
  const [contents, setContents] = useState<Record<number, string[]>>({});
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [list, paths] = await Promise.all([
        loadPlaylists(),
        loadPlaylistContents(),
      ]);
      setAll(list);
      setContents(paths);
    } catch {
      // A database that will not answer is already reported by the library
      // view; playlists staying empty is the honest consequence, not a second
      // error dialog.
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Writes one playlist's new order, having already shown it. */
  const write = useCallback(
    async (id: number, next: string[]) => {
      setContents((prev) => ({ ...prev, [id]: next }));
      try {
        await setPlaylistPaths(id, next);
      } finally {
        // Even after a failure: what the database ended up with is what the
        // screen should show, and that is a question only it can answer.
        await reload();
      }
    },
    [reload],
  );

  const create = useCallback(
    async (name: string) => {
      try {
        const id = await createPlaylist(name);
        await reload();
        return id;
      } catch {
        return null;
      }
    },
    [reload],
  );

  const rename = useCallback(
    async (id: number, name: string) => {
      const trimmed = name.trim();
      // An empty name is a cancelled edit, not a playlist called "".
      if (!trimmed) return;
      await renamePlaylist(id, trimmed).catch(() => {});
      await reload();
    },
    [reload],
  );

  const remove = useCallback(
    async (id: number) => {
      await deletePlaylist(id).catch(() => {});
      await reload();
    },
    [reload],
  );

  const add = useCallback(
    async (id: number, paths: string[]) => {
      const next = addToPlaylist(contents[id] ?? [], paths);
      if (next === (contents[id] ?? [])) return;
      await write(id, next);
    },
    [contents, write],
  );

  const removeTracks = useCallback(
    async (id: number, paths: string[]) => {
      await write(id, removeFromPlaylist(contents[id] ?? [], paths));
    },
    [contents, write],
  );

  const move = useCallback(
    async (id: number, paths: string[], before: string | null) => {
      const current = contents[id] ?? [];
      const next = movePlaylistItems(current, paths, before);
      if (next === current) return;
      await write(id, next);
    },
    [contents, write],
  );

  const step = useCallback(
    async (id: number, path: string, direction: -1 | 1) => {
      const current = contents[id] ?? [];
      const next = stepPlaylistItem(current, path, direction);
      if (next === current) return;
      await write(id, next);
    },
    [contents, write],
  );

  const suggestName = useCallback(
    (base: string) => uniquePlaylistName(all, base),
    [all],
  );

  return {
    all,
    contents,
    loaded,
    create,
    rename,
    remove,
    add,
    removeTracks,
    move,
    step,
    suggestName,
    reload,
  };
}
