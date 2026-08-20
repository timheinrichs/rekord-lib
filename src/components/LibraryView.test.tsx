import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeMetadata, makeTrack } from "../test/factories";
import { DEFAULT_SETTINGS, type Settings } from "../lib/settings";
import type { TrackAnalysis } from "../types";


/**
 * A harness for `LibraryView`, which is the one component whose bugs are
 * *wiring* bugs: it decides when to scan, when to sync, and what to hand to the
 * tempo backlog. None of that is visible to the pure helpers in `src/lib`, and
 * the race this file's first test covers cost a fresh library its tempos while
 * every unit test stayed green.
 *
 * The mocks stand in for everything that would reach the backend. They are
 * hoisted (`vi.hoisted`) because `vi.mock` factories run before imports, and
 * they are plain `vi.fn()`s so a test can assert on the calls the component
 * made — which is the point, since the interesting behaviour is "did it ask the
 * backend the right thing", not what it rendered.
 */
const mocks = vi.hoisted(() => {
  const unlisten = () => {};
  const listener = <T,>(store: { cb?: (value: T) => void }) =>
    vi.fn(async (cb: (value: T) => void) => {
      store.cb = cb;
      return unlisten;
    });
  return {
    // Captured event callbacks, so a test can drive the component the way the
    // backend would.
    scanDone: {} as { cb?: (d: unknown) => void },
    libraryChanged: {} as { cb?: () => void },
    listener,

    // --- lib/api -----------------------------------------------------------
    // Typed with a loose argument list so a test can index into `mock.calls`:
    // the calls are the assertion here, not the return values.
    analyzeFiles: vi.fn(async (..._args: unknown[]) => [] as TrackAnalysis[]),
    startScan: vi.fn(async (..._args: unknown[]) => true),
    scanStatus: vi.fn(async () => ({
      running: false,
      paused: false,
      generation: 0,
      done: 0,
      total: 0,
      stage: "",
    })),
    listAudioFiles: vi.fn(async () => [] as string[]),
    sidecarError: vi.fn(async () => null),
    startLibraryWatch: vi.fn(async () => {}),
    undoPeek: vi.fn(async () => null),
    coverThumbnail: vi.fn(async () => null),

    // --- lib/library -------------------------------------------------------
    loadLibraryTracks: vi.fn(async () => [] as TrackAnalysis[]),
    loadEdits: vi.fn(async () => ({})),
    isLibraryDirAvailable: vi.fn(async () => true),
    forgetTracks: vi.fn(async () => {}),

    // --- lib/duplicates ----------------------------------------------------
    loadDuplicates: vi.fn(async () => []),
  };
});

vi.mock("../lib/api", () => ({
  analyzeFiles: mocks.analyzeFiles,
  startScan: mocks.startScan,
  scanStatus: mocks.scanStatus,
  listAudioFiles: mocks.listAudioFiles,
  sidecarError: mocks.sidecarError,
  startLibraryWatch: mocks.startLibraryWatch,
  undoPeek: mocks.undoPeek,
  coverThumbnail: mocks.coverThumbnail,
  convertTracks: vi.fn(),
  deleteAlbum: vi.fn(),
  deleteFiles: vi.fn(),
  pruneEmptyDirs: vi.fn(),
  pickOutputDir: vi.fn(),
  setScanPaused: vi.fn(),
  undoLast: vi.fn(),
  writeMetadata: vi.fn(),
  onConvertProgress: mocks.listener({}),
  onDedupeDone: mocks.listener({}),
  onDedupeProgress: mocks.listener({}),
  onLibraryChanged: mocks.listener(mocks.libraryChanged),
  onScanDone: mocks.listener(mocks.scanDone),
  onScanProgress: mocks.listener({}),
  onScanSkipped: mocks.listener({}),
  onScanTracks: mocks.listener({}),
}));

vi.mock("../lib/library", () => ({
  loadLibraryTracks: mocks.loadLibraryTracks,
  loadEdits: mocks.loadEdits,
  isLibraryDirAvailable: mocks.isLibraryDirAvailable,
  forgetTracks: mocks.forgetTracks,
  clearEdits: vi.fn(),
  relocateLibrary: vi.fn(),
  saveEdit: vi.fn(),
}));

vi.mock("../lib/duplicates", () => ({
  loadDuplicates: mocks.loadDuplicates,
  saveDuplicates: vi.fn(),
  dismissDuplicates: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(async () => false) }));

// The player owns audio playback; the library only asks it what is playing.
vi.mock("../lib/player", () => ({
  usePlayer: () => ({
    current: null,
    playing: false,
    hasNext: false,
    hasPrev: false,
    index: 0,
    total: 0,
    positioned: false,
    play: vi.fn(),
    toggle: vi.fn(),
    next: vi.fn(),
    prev: vi.fn(),
    close: vi.fn(),
    seek: vi.fn(),
  }),
}));

// Imported after the mocks are declared, which is what vi.mock's hoisting is for.
const { default: LibraryView } = await import("./LibraryView");

function renderLibrary(over: Partial<Settings> = {}) {
  const settings: Settings = { ...DEFAULT_SETTINGS, library_dir: "/lib", ...over };
  return render(
    <LibraryView settings={settings} originById={{}} onOpenSettings={() => {}} />,
  );
}

/** A track as the scan produces it before tempo detection has run. */
function untagged(name: string): TrackAnalysis {
  return makeTrack({
    id: `/lib/${name}`,
    path: `/lib/${name}`,
    metadata: makeMetadata({ bpm: null }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.startScan.mockResolvedValue(true);
  mocks.scanStatus.mockResolvedValue({
    running: false,
    paused: false,
    generation: 0,
    done: 0,
    total: 0,
    stage: "",
  });
  mocks.loadLibraryTracks.mockResolvedValue([]);
  mocks.loadEdits.mockResolvedValue({});
  mocks.isLibraryDirAvailable.mockResolvedValue(true);
  mocks.loadDuplicates.mockResolvedValue([]);
  mocks.listAudioFiles.mockResolvedValue([]);
  mocks.analyzeFiles.mockResolvedValue([]);
});

describe("tempo backlog on start-up", () => {
  it("detects tempos on the very first run over a fresh library", async () => {
    // The regression this file exists for. With an empty database the sync is
    // what discovers the files, and the backlog used to read a track list React
    // had not re-rendered yet — so nothing looked to be missing a tempo, no job
    // started, and detection only began on the *second* launch.
    mocks.loadLibraryTracks.mockResolvedValue([]);
    mocks.listAudioFiles.mockResolvedValue(["/lib/a.aiff", "/lib/b.aiff"]);
    mocks.analyzeFiles.mockResolvedValue([untagged("a.aiff"), untagged("b.aiff")]);

    renderLibrary();

    await waitFor(() => expect(mocks.startScan).toHaveBeenCalled());
    const [dir, analyzeBpm, paths] = mocks.startScan.mock.calls[0];
    expect(dir).toBe("/lib");
    expect(analyzeBpm).toBe(true);
    expect(paths).toEqual(["/lib/a.aiff", "/lib/b.aiff"]);
  });

  it("passes the configured tempo range to the detector", async () => {
    // The setting is useless if it stops at the component boundary, and nothing
    // else in the suite crosses that boundary.
    mocks.listAudioFiles.mockResolvedValue(["/lib/a.aiff"]);
    mocks.analyzeFiles.mockResolvedValue([untagged("a.aiff")]);

    renderLibrary({ bpm_min: 70, bpm_max: 140 });

    await waitFor(() => expect(mocks.startScan).toHaveBeenCalled());
    expect(mocks.startScan.mock.calls[0][5]).toEqual({ min: 70, max: 140 });
  });

  it("does not start a job when every track already has a tempo", async () => {
    // Cheap to call from everywhere is only true if it is a no-op when there is
    // nothing to do; otherwise every sync would kick off a pointless scan.
    const tagged = makeTrack({
      id: "/lib/a.aiff",
      path: "/lib/a.aiff",
      metadata: makeMetadata({ bpm: 128 }),
    });
    mocks.loadLibraryTracks.mockResolvedValue([tagged]);
    mocks.listAudioFiles.mockResolvedValue(["/lib/a.aiff"]);

    renderLibrary();

    await waitFor(() => expect(mocks.scanStatus).toHaveBeenCalled());
    await waitFor(() => expect(mocks.isLibraryDirAvailable).toHaveBeenCalled());
    expect(mocks.startScan).not.toHaveBeenCalled();
  });

  it("leaves detection alone when the user turned it off", async () => {
    mocks.listAudioFiles.mockResolvedValue(["/lib/a.aiff"]);
    mocks.analyzeFiles.mockResolvedValue([untagged("a.aiff")]);

    renderLibrary({ analyze_bpm: false });

    await waitFor(() => expect(mocks.isLibraryDirAvailable).toHaveBeenCalled());
    expect(mocks.startScan).not.toHaveBeenCalled();
  });

  it("does not re-queue a file whose tempo could not be detected", async () => {
    // A file that yields no tempo keeps looking like it is missing one. Without
    // the per-session guard the backlog would hand it to a new job forever.
    mocks.listAudioFiles.mockResolvedValue(["/lib/a.aiff"]);
    mocks.analyzeFiles.mockResolvedValue([untagged("a.aiff")]);

    renderLibrary();
    await waitFor(() => expect(mocks.startScan).toHaveBeenCalledTimes(1));

    // A finished scan asks the backlog to keep going; the same still-untagged
    // file must not be picked up again.
    mocks.scanDone.cb?.({ generation: 1, cancelled: false, full: false, tracks: [] });
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.startScan).toHaveBeenCalledTimes(1);
  });

  it("docks onto a scan that is already running instead of starting another", async () => {
    mocks.scanStatus.mockResolvedValue({
      running: true,
      paused: false,
      generation: 3,
      done: 10,
      total: 100,
      stage: "Analyzing",
    });
    mocks.listAudioFiles.mockResolvedValue(["/lib/a.aiff"]);

    renderLibrary();

    await waitFor(() => expect(mocks.scanStatus).toHaveBeenCalled());
    expect(mocks.startScan).not.toHaveBeenCalled();
    // Nor does it sync behind the running scan's back.
    expect(mocks.analyzeFiles).not.toHaveBeenCalled();
  });
});

describe("the incremental sync", () => {
  it("forgets files that disappeared from disk", async () => {
    // Otherwise the next start serves them from the cache and the library shows
    // tracks that are not there any more.
    mocks.loadLibraryTracks.mockResolvedValue([untagged("gone.aiff"), untagged("here.aiff")]);
    mocks.listAudioFiles.mockResolvedValue(["/lib/here.aiff"]);

    renderLibrary();

    await waitFor(() => expect(mocks.forgetTracks).toHaveBeenCalledWith(["/lib/gone.aiff"]));
  });

  it("treats an unreachable folder as unknown, not as empty", async () => {
    // The dangerous case: an unmounted drive read as "every file was deleted"
    // would wipe the whole library from the database.
    mocks.loadLibraryTracks.mockResolvedValue([untagged("a.aiff"), untagged("b.aiff")]);
    mocks.isLibraryDirAvailable.mockResolvedValue(false);

    renderLibrary();

    await waitFor(() => expect(mocks.isLibraryDirAvailable).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.forgetTracks).not.toHaveBeenCalled();
  });

  it("analyses only the files that are new", async () => {
    mocks.loadLibraryTracks.mockResolvedValue([untagged("old.aiff")]);
    mocks.listAudioFiles.mockResolvedValue(["/lib/old.aiff", "/lib/new.aiff"]);
    mocks.analyzeFiles.mockResolvedValue([untagged("new.aiff")]);

    renderLibrary();

    await waitFor(() => expect(mocks.analyzeFiles).toHaveBeenCalled());
    expect(mocks.analyzeFiles.mock.calls[0][0]).toEqual(["/lib/new.aiff"]);
    // Without a BPM: the backlog does that afterwards, so a folder of new files
    // appears in the list immediately instead of after every decode.
    expect(mocks.analyzeFiles.mock.calls[0][1]).toBe(false);
  });
});
