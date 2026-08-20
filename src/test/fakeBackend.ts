/**
 * One fake backend for the whole frontend, wired in at the IPC boundary.
 *
 * The component tests next to each view mock `../lib/api`, which means the
 * wrapper module never runs: a renamed command, a wrong argument name and a
 * changed payload shape all pass. This fake replaces `invoke` instead, so
 * `App.tsx` → `lib/api.ts` → `invoke("start_scan", { bpmMin: … })` runs for
 * real and only the Rust side is imaginary. `docs/COMMANDS.md` is the contract
 * it answers by; a drift between that document and the code shows up here as a
 * failing test.
 *
 * It reaches further than `invoke`, because every Tauri plugin the app uses
 * talks over the same channel (`plugin:store|get`, `plugin:dialog|open`,
 * `plugin:updater|check`, …). So the store, the file dialogs, the opener and the
 * updater are served here too, and no test needs `vi.mock` at all — including
 * events, which `mockIPC`'s own `shouldMockEvents` handles, so the real `listen`
 * runs and `emit` delivers.
 *
 * Three conventions from `docs/COMMANDS.md` that this file exists to hold the
 * app to:
 *
 * - **Arguments are camelCase, payloads are snake_case.** Tauri renames the
 *   former; nothing renames the latter.
 * - **A plain return type never rejects.** `write_metadata`, the three deletes
 *   and `bandcamp_download` report failure *inside* the value — a per-item
 *   `error`, or `success: false`. Use `failItem`, not `fail`, for those.
 * - **Derived values are recomputed, not stored.** `compat` and
 *   `metadata_incomplete` come back from the backend on every read, so the fake
 *   returns whatever the seeded track says and never tries to be clever.
 */
import { emit } from "@tauri-apps/api/event";
import {
  clearMocks,
  mockConvertFileSrc,
  mockIPC,
  mockWindows,
} from "@tauri-apps/api/mocks";
import type {
  AppEvent,
  BandcampAccount,
  BandcampItem,
  ConvertJob,
  ConvertResult,
  DeleteResult,
  DuplicateGroup,
  EventLog,
  MetadataSuggestions,
  RelocateResult,
  ScanStatus,
  TrackAnalysis,
  TrackEdit,
} from "../types";
import { STAGE_ANALYZING } from "../types";
import type { UndoEntry, WriteMetadataItem } from "../lib/api";
import { makeMetadata, makeTrack } from "./factories";

/** Everything the fake backend knows. Every field is seedable per test. */
export interface FakeState {
  /**
   * The audio files on disk, which is a different thing from the rows in the
   * database — the whole point of the incremental sync is the diff between the
   * two. `list_audio_files` answers from here; `library_load` answers from
   * `tracks`. A first run seeds `files` and leaves `tracks` empty.
   */
  files: string[];
  tracks: TrackAnalysis[];
  edits: Record<string, TrackEdit>;
  groups: DuplicateGroup[];
  events: AppEvent[];
  undo: UndoEntry[];
  /** The JSON store (`rekord-lib.json`), keyed as the real one is. */
  store: Record<string, unknown>;
  account: BandcampAccount | null;
  collection: BandcampItem[];
  /** Non-null makes the app report a broken ffmpeg/ffprobe at startup. */
  sidecarError: string | null;
  /**
   * `false` makes every database-backed command reject the way `db::require`
   * does when `Db::open` failed. The app has to survive it — the library is
   * empty and the next scan rebuilds it, which beats refusing to launch.
   */
  dbAvailable: boolean;
  /** What the next file/folder dialog returns. `null` is a cancelled dialog. */
  dialogAnswer: string | string[] | null;
  /** Files the analysis skips, reported per path. */
  skipped: Record<string, string>;
  scan: ScanStatus;
}

const DB_UNAVAILABLE = "the library database is unavailable";

function defaults(): FakeState {
  return {
    files: [],
    tracks: [],
    edits: {},
    groups: [],
    events: [],
    undo: [],
    store: {},
    account: null,
    collection: [],
    sidecarError: null,
    dbAvailable: true,
    dialogAnswer: null,
    skipped: {},
    scan: {
      running: false,
      paused: false,
      generation: 0,
      done: 0,
      total: 0,
      stage: STAGE_ANALYZING,
    },
  };
}

/** One recorded trip across the boundary. */
export interface FakeCall {
  cmd: string;
  args: Record<string, unknown>;
}

export interface FakeBackend {
  state: FakeState;
  /** Every `invoke`, in order, including the plugin channels. */
  calls: FakeCall[];
  /** The arguments of every call to `cmd`, oldest first. */
  argsFor(cmd: string): Record<string, unknown>[];
  /** Whether `cmd` was called at all. */
  called(cmd: string): boolean;
  /** Make `cmd` reject. For commands that legitimately return an error. */
  fail(cmd: string, message: string): void;
  /**
   * Make one path fail *inside* an otherwise successful return — the shape
   * `write_metadata`, the deletes and `convert_tracks` actually use.
   */
  failItem(path: string, message: string): void;
  /** Emit a backend event through the real `listen` machinery. */
  emit(event: string, payload: unknown): Promise<void>;
  /** Undo everything this installed. */
  restore(): void;
}

/**
 * Serves one command. Returning `undefined` means "not mine", which is how the
 * plugin channels and the app's own commands stay in separate tables without a
 * single 40-case switch.
 */
type Handler = (
  args: Record<string, unknown>,
  fake: FakeState,
) => unknown;

/** A track for a path the fake has never seen, so a first scan can produce rows. */
function trackFor(path: string): TrackAnalysis {
  return makeTrack({ path, id: path });
}

export function installFakeBackend(
  seed: Partial<FakeState> = {},
): FakeBackend {
  const state: FakeState = { ...defaults(), ...seed };
  const calls: FakeCall[] = [];
  const rejections = new Map<string, string>();
  const itemErrors = new Map<string, string>();

  const byPath = (path: string) => state.tracks.find((t) => t.path === path);

  /** The app's own commands, named exactly as `generate_handler!` registers them. */
  const commands: Record<string, Handler> = {
    // --- analysis and the scan job ---
    analyze_files: (args) => {
      const paths = (args.paths as string[]) ?? [];
      const produced: TrackAnalysis[] = [];
      for (const path of paths) {
        if (state.skipped[path]) continue;
        const existing = byPath(path);
        const track = existing ?? trackFor(path);
        if (!existing) state.tracks.push(track);
        if (!state.files.includes(path)) state.files.push(path);
        produced.push(track);
      }
      return produced;
    },
    start_scan: () => {
      if (state.scan.running) return false;
      state.scan = { ...state.scan, running: true, generation: state.scan.generation + 1 };
      return true;
    },
    scan_status: () => state.scan,
    cancel_scan: () => {
      state.scan = { ...state.scan, running: false, paused: false };
      return null;
    },
    set_scan_paused: (args) => {
      state.scan = { ...state.scan, paused: !!args.paused };
      return null;
    },
    sidecar_error: () => state.sidecarError,
    list_audio_files: () => state.files,
    start_library_watch: () => null,
    waveform: () => ({ peak: [], rms: [] }),
    stored_waveforms: () => ({}),

    // --- library and edits ---
    library_load: () => state.tracks,
    library_delete: (args) => {
      const paths = new Set((args.paths as string[]) ?? []);
      const before = state.tracks.length;
      state.tracks = state.tracks.filter((t) => !paths.has(t.path));
      return before - state.tracks.length;
    },
    library_dir_available: () => true,
    library_relocate: (): RelocateResult => ({ moved: state.tracks.length, skipped: 0 }),
    edits_load: () => state.edits,
    edit_set: (args) => {
      state.edits[args.path as string] = args.edit as TrackEdit;
      return null;
    },
    edit_clear: (args) => {
      for (const path of (args.paths as string[]) ?? []) delete state.edits[path];
      return null;
    },

    // --- duplicates ---
    duplicates_load: () => state.groups,
    duplicates_save: (args) => {
      state.groups = (args.groups as DuplicateGroup[]) ?? [];
      return null;
    },
    duplicates_dismiss: (args) => {
      state.groups = state.groups.filter((g) => g.id !== args.id);
      return null;
    },
    dedupe_status: () => ({
      running: false,
      generation: state.scan.generation,
      done: 0,
      total: 0,
      stage: "",
      has_result: state.groups.length > 0,
    }),
    dedupe_result: () => (state.groups.length ? state.groups : null),
    cancel_dedupe: () => null,

    // --- metadata, undo ---
    suggest_metadata: (args): MetadataSuggestions => {
      const path = args.path as string;
      const current = byPath(path)?.metadata ?? makeMetadata();
      return {
        id: path,
        current,
        filename_guess: current,
        candidates: [],
        field_suggestions: { genres: [], years: [], labels: [], countries: [] },
      };
    },
    cover_preview: () => "data:image/jpeg;base64,",
    cover_thumbnail: () => null,
    write_metadata: (args) => {
      const items = (args.items as WriteMetadataItem[]) ?? [];
      if (args.recordUndo !== false) {
        state.undo.push({
          id: state.undo.length + 1,
          label: (args.label as string) ?? "",
          // What the real backend snapshots: the tags as they were *before*.
          items: items.map((i) => ({
            path: i.path,
            metadata: byPath(i.path)?.metadata ?? i.metadata,
          })),
        });
      }
      return items.map((item) => {
        const error = itemErrors.get(item.path);
        if (error) return { path: item.path, track: null, error };
        const track = byPath(item.path);
        const written = { ...(track ?? trackFor(item.path)), metadata: item.metadata };
        if (track) state.tracks = state.tracks.map((t) => (t.path === track.path ? written : t));
        return { path: item.path, track: written, error: null };
      });
    },
    undo_peek: () => state.undo[state.undo.length - 1] ?? null,
    undo_last: () => {
      const entry = state.undo.pop();
      if (!entry) return [];
      return entry.items.map((item) => {
        const track = byPath(item.path);
        const restored = { ...(track ?? trackFor(item.path)), metadata: item.metadata };
        if (track) state.tracks = state.tracks.map((t) => (t.path === track.path ? restored : t));
        return { path: item.path, track: restored, error: null };
      });
    },

    // --- conversion ---
    convert_tracks: (args): ConvertResult[] => {
      const jobs = (args.jobs as ConvertJob[]) ?? [];
      return jobs.map((job) => {
        const error = itemErrors.get(job.path);
        return {
          id: job.id,
          source_path: job.path,
          output_path: error ? null : `${job.path}.converted`,
          success: !error,
          error: error ?? null,
        };
      });
    },

    // --- deletion ---
    delete_files: (args) => trash((args.paths as string[]) ?? []),
    delete_album: (args) => trash((args.paths as string[]) ?? []),
    prune_empty_dirs: (args) =>
      ((args.dirs as string[]) ?? []).map((path) => ({ path, success: true, error: null })),

    // --- the event log ---
    events_load: (): EventLog => ({ events: state.events, seen_id: 0 }),
    events_mark_seen: () => null,
    events_clear: () => {
      const n = state.events.length;
      state.events = [];
      return n;
    },

    // --- Bandcamp ---
    bandcamp_login: () => null,
    bandcamp_connect: () => state.account,
    bandcamp_status: () => state.account,
    bandcamp_disconnect: () => {
      state.account = null;
      return null;
    },
    bandcamp_collection: () => state.collection,
    bandcamp_download: (args) => {
      const key = args.key as string;
      const error = itemErrors.get(key);
      return {
        key,
        files: error ? [] : [`${args.destDir}/${key}.flac`],
        success: !error,
        error: error ?? null,
      };
    },
    cancel_bandcamp_download: () => null,
  };

  function trash(paths: string[]): DeleteResult[] {
    return paths.map((path) => {
      const error = itemErrors.get(path);
      if (!error) {
        state.tracks = state.tracks.filter((t) => t.path !== path);
        state.files = state.files.filter((f) => f !== path);
      }
      return { path, success: !error, error: error ?? null };
    });
  }

  /** Commands that go through the database, and so fail when it is unavailable. */
  const NEEDS_DB = new Set([
    "library_load",
    "library_delete",
    "library_relocate",
    "edits_load",
    "edit_set",
    "edit_clear",
    "duplicates_load",
    "duplicates_save",
    "duplicates_dismiss",
    "events_load",
    "events_mark_seen",
    "events_clear",
    "undo_peek",
    "undo_last",
    "stored_waveforms",
  ]);

  /** The plugin channels, which are `invoke` calls like any other. */
  const plugins: Record<string, Handler> = {
    "plugin:store|load": () => 1,
    "plugin:store|get_store": () => 1,
    "plugin:store|get": (args) => {
      const key = args.key as string;
      return key in state.store ? [state.store[key], true] : [null, false];
    },
    "plugin:store|set": (args) => {
      state.store[args.key as string] = args.value;
      return null;
    },
    "plugin:store|has": (args) => (args.key as string) in state.store,
    "plugin:store|delete": (args) => delete state.store[args.key as string],
    "plugin:store|keys": () => Object.keys(state.store),
    "plugin:store|entries": () => Object.entries(state.store),
    "plugin:store|save": () => null,
    "plugin:store|reload": () => null,
    // The dialogs. `open` is the file/folder picker; `message` backs `ask`.
    "plugin:dialog|open": () => state.dialogAnswer,
    "plugin:dialog|message": () => true,
    "plugin:dialog|save": () => state.dialogAnswer,
    "plugin:opener|open_url": () => null,
    "plugin:opener|open_path": () => null,
    "plugin:opener|reveal_item_in_dir": () => null,
    // No update waiting, unless a test says otherwise via `fail`/seeding.
    "plugin:updater|check": () => null,
    "plugin:process|restart": () => null,
    "plugin:process|exit": () => null,
    "plugin:app|version": () => "0.0.0-test",
    "plugin:app|name": () => "rekord-lib",
    "plugin:app|identifier": () => "com.timheinrichs.rekord-lib-test",
  };

  mockWindows("main");
  mockConvertFileSrc("macos");
  mockIPC(
    (cmd, args) => {
      const payload = (args ?? {}) as Record<string, unknown>;
      calls.push({ cmd, args: payload });

      const rejection = rejections.get(cmd);
      if (rejection) return Promise.reject(new Error(rejection));

      if (NEEDS_DB.has(cmd) && !state.dbAvailable) {
        return Promise.reject(new Error(DB_UNAVAILABLE));
      }

      const handler = commands[cmd] ?? plugins[cmd];
      if (!handler) {
        // Loud on purpose. A command the fake does not know is either a new one
        // that belongs in the table above, or a renamed one — and a silent
        // `undefined` would surface as an unrelated render failure three
        // assertions later.
        throw new Error(
          `fakeBackend: no handler for "${cmd}". Add it here and to docs/COMMANDS.md.`,
        );
      }
      return handler(payload, state);
    },
    { shouldMockEvents: true },
  );

  return {
    state,
    calls,
    argsFor: (cmd) => calls.filter((c) => c.cmd === cmd).map((c) => c.args),
    called: (cmd) => calls.some((c) => c.cmd === cmd),
    fail: (cmd, message) => rejections.set(cmd, message),
    failItem: (path, message) => itemErrors.set(path, message),
    emit: async (event, payload) => {
      await emit(event, payload);
    },
    restore: () => {
      clearMocks();
      // Unsubscribing is asynchronous: a component that unmounted during the
      // test resolves its `listen` promise and calls `unlisten` after this
      // point, and `clearMocks` has just deleted the function it goes through.
      // Leaving no-ops behind turns that race into nothing instead of an
      // unhandled rejection in the next test's report.
      const internals = window as unknown as {
        __TAURI_INTERNALS__?: Record<string, unknown>;
        __TAURI_EVENT_PLUGIN_INTERNALS__?: Record<string, unknown>;
      };
      if (internals.__TAURI_INTERNALS__) {
        internals.__TAURI_INTERNALS__.invoke = () => Promise.resolve(null);
      }
      if (internals.__TAURI_EVENT_PLUGIN_INTERNALS__) {
        internals.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener = () => {};
      }
    },
  };
}
