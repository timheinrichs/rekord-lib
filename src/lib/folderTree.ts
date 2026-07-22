import type { TrackAnalysis } from "../types";

/** A folder in the library tree: its subfolders and the tracks directly in it. */
export interface FolderNode {
  /** Display name (last path segment); "" for the synthetic root. */
  name: string;
  /** Absolute folder path (stable key for expand state). */
  path: string;
  folders: FolderNode[];
  tracks: TrackAnalysis[];
}

/** Natural, case-insensitive compare (so "Track 2" sorts before "Track 10"). */
function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/** Orders tracks within a folder by track number (nulls last), then title. */
function sortFolderTracks(tracks: TrackAnalysis[]): TrackAnalysis[] {
  return [...tracks].sort((a, b) => {
    const na = a.metadata.track_number ?? Number.MAX_SAFE_INTEGER;
    const nb = b.metadata.track_number ?? Number.MAX_SAFE_INTEGER;
    if (na !== nb) return na - nb;
    return byName(a.metadata.title ?? a.file_name, b.metadata.title ?? b.file_name);
  });
}

function sortNode(node: FolderNode): FolderNode {
  node.folders.sort((a, b) => byName(a.name, b.name));
  node.folders.forEach(sortNode);
  node.tracks = sortFolderTracks(node.tracks);
  return node;
}

/**
 * Builds a folder tree from the tracks' paths, relative to `rootDir`. Each track
 * is placed in the node for its parent directory; intermediate folders are
 * created as needed. Tracks outside `rootDir` (or directly in it) land in the
 * returned root node. Pure.
 */
export function buildFolderTree(
  tracks: TrackAnalysis[],
  rootDir: string,
): FolderNode {
  const root: FolderNode = { name: "", path: rootDir, folders: [], tracks: [] };
  const base = rootDir.replace(/\/+$/, "");

  for (const t of tracks) {
    const rel = t.path.startsWith(base + "/")
      ? t.path.slice(base.length + 1)
      : t.path;
    const segments = rel.split("/");
    segments.pop(); // drop the file name → folder segments only

    let node = root;
    let acc = base;
    for (const seg of segments) {
      if (!seg) continue;
      acc = `${acc}/${seg}`;
      let child = node.folders.find((f) => f.path === acc);
      if (!child) {
        child = { name: seg, path: acc, folders: [], tracks: [] };
        node.folders.push(child);
      }
      node = child;
    }
    node.tracks.push(t);
  }

  return sortNode(root);
}

/**
 * All tracks contained in a folder node, including its subfolders (recursive),
 * in render order: subfolders first, then the folder's own tracks.
 */
export function folderTrackList(node: FolderNode): TrackAnalysis[] {
  const out: TrackAnalysis[] = [];
  for (const f of node.folders) out.push(...folderTrackList(f));
  out.push(...node.tracks);
  return out;
}

/** Paths of every folder in the tree (for expand/collapse-all). */
export function allFolderPaths(node: FolderNode): string[] {
  const out: string[] = [];
  for (const f of node.folders) {
    out.push(f.path);
    out.push(...allFolderPaths(f));
  }
  return out;
}
