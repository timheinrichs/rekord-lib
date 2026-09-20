import { useCallback, useEffect, useState } from "react";

import { clearGridEdits, loadGridEdits, saveGridEdit } from "./library";
import type { GridEdit } from "../types";

/**
 * The hand-set beat grids, loaded once and kept in step with what is written.
 *
 * Shaped like `usePlaylists`: the state lives with whoever mounts the hook, the
 * write goes to the backend first and the local copy follows, so a failed write
 * cannot leave the screen claiming something the database does not hold.
 *
 * All of them rather than the one on screen, because the whole map is one small
 * query — a row exists only for a track somebody has corrected — and the export
 * reads the same map on the Rust side.
 */
export function useGridEdits() {
  const [edits, setEdits] = useState<Record<string, GridEdit>>({});

  useEffect(() => {
    // A database that is not there is not an error here: the surface still
    // draws the detected grid, which is what a track has until somebody moves
    // it.
    void loadGridEdits()
      .then(setEdits)
      .catch(() => {});
  }, []);

  const place = useCallback(async (path: string, edit: GridEdit) => {
    await saveGridEdit(path, edit);
    setEdits((all) => ({ ...all, [path]: edit }));
  }, []);

  const reset = useCallback(async (path: string) => {
    await clearGridEdits([path]);
    setEdits((all) => {
      const next = { ...all };
      delete next[path];
      return next;
    });
  }, []);

  return { edits, place, reset };
}
