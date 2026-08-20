# Session plan — end-to-end tests (G1)

Temporary. Deleted in the release commit that performs the bump — see
**Workflow** in `CLAUDE.md`.

## Why

`docs/FUTURE_CONSIDERATIONS.md` records **G1 · End-to-end tests** with one
sentence that is the whole argument: *"Unit tests do not catch a broken wiring
between a command and a view."* The same sentence opens `CLAUDE.md`'s **Driving
the real app** section, which is G1's stand-in today — a human clicks through
`npm run tauri dev` and hopes to notice.

The numbers say how one-sided the coverage is: 227 Rust tests and 49 frontend
test files, and **every one of them sits on one side of the IPC boundary**.
Exactly one test calls a command function at all — `prune_empty_dirs`, the only
command taking neither `AppHandle` nor `State`. On the frontend the two best
integration tests, `LibraryView.test.tsx` and `MetadataEditor.test.tsx`, mock
`../lib/api`, so they assert against a hand-written stub *of the boundary*
rather than across it. The command names, the camelCase argument renaming, the
event payload shapes and the "failure is inside the value, not a rejection"
convention are covered by nothing.

`TODO.md` now names the holes that leaves, under *Test coverage that is thinner
than it looks*: `convert_tracks` has no test at all, `metadata::write::finalize`
none end to end, `metadata/artwork.rs` none, `audio::dedupe::find_duplicates`
none because it needs an `AppHandle`, `DuplicatesModal.tsx` no test file. That
table is this session's target list, and the entry says so: *"That is **G1**
territory in the roadmap."*

**G1 as written is not buildable.** It names WebdriverIO plus `tauri-driver`,
and `tauri-driver` has no macOS support — there is no WKWebView driver tool, and
this app ships macOS-arm64 only. What has appeared since the item was written is
`@wdio/tauri-service` 1.3.0 (2026-08-03) with an **embedded** WebDriver server
inside the app (`tauri-plugin-wdio-webdriver` 1.3.0), which covers WKWebView.
Its own documentation carries the warning that decides this plan's shape:
*"This plugin exposes automation capabilities via HTTP. Never include it in
production builds."*

## Version — PATCH, `0.7.1` → `0.7.2`

Tests, a dev-only Cargo feature, a new workflow and one document. Nothing new
in the app and nothing a user sees, which at `0.x` is a **PATCH**. The plan
proposes the number; it does not bump it.

## Two layers, and why both

| | Layer 1 · flow tests | Layer 2 · real e2e |
| --- | --- | --- |
| Where | `src/e2e/*.e2e.test.tsx` | `e2e/*.spec.ts` |
| Runs in | jsdom, `npm test`, seconds | the built `.app`, `npm run e2e`, minutes |
| Backend | one fake, at the **raw IPC boundary** | the real Rust process |
| Catches | wiring, command names, argument casing, event shapes, call order, empty and error states | what only a real window and real files show |

Layer 1 is where the coverage comes from; layer 2 is where the claim "the real
app works" comes from. Layer 1 alone would keep mocking the boundary. Layer 2
alone would be too slow and too flaky to gate anything, and the roadmap's own
*Deliberately not adopted* section commits us to a CI gate that stays green.

### The decision that makes layer 1 worth having

**Mock `invoke`, not `../lib/api`.** The existing component tests replace the
wrapper module, so the real `src/lib/api.ts` never runs and a renamed command or
a wrong `bpmMin` casing passes. Layer 1 uses `mockIPC` from
`@tauri-apps/api/mocks` and lets the whole frontend stack run for real —
`App.tsx` → `lib/api.ts` → `invoke("start_scan", {…})` — with one fake backend
answering by command name. `docs/COMMANDS.md` is the contract it is written
against, so a drift between document and code becomes a failing test.

Four seams stay module-mocked on purpose, because pinning them would pin Tauri
internals rather than our own code:

- `@tauri-apps/api/event` — a small event bus, so a test can push `scan://patch`
  and `convert://progress` the way `LibraryView.test.tsx` captures callbacks
  today. `mockIPC` covers `invoke`; it does not wire emit.
- `@tauri-apps/plugin-store` — an in-memory `Store`, as
  `src/lib/settings.test.ts` already does. The plugin's resource-id protocol is
  not a contract worth encoding.
- `@tauri-apps/plugin-dialog` / `-opener` / `-updater` / `-process`.
- `api/window`, `api/webview`, `api/app`, and `convertFileSrc` via
  `mockConvertFileSrc` — the places components reach past the wrapper.

## What ships

**`src/test/fakeBackend.ts`** — the fake, and the one piece of real design work
here. In-memory state (tracks, edits, duplicate groups, events, undo stack,
Bandcamp collection) seeded through the existing `src/test/factories.ts`, one
handler per command name, an `emit()` for the bus, and knobs for the states that
are otherwise unreachable: an absent database (`db::require` returns
`AppError::Db`, which the app must survive), a sidecar self-test failure, a
per-item `error` inside an otherwise successful return, an unreadable folder.

**Seven flows**, `src/e2e/<flow>.e2e.test.tsx`, one commit each:

1. **`firstRun`** — empty state → settings → folder pick → rows appear. The
   first population does **not** go through `start_scan`; the incremental sync
   hands every new file to `analyze_files`, one blocking command with no
   progress and no pause gate (`TODO.md`, C5a). The test asserts that path.
2. **`scan`** — `start_scan` with the right arguments, then `scan://tracks`,
   `scan://patch` (a `null` field means *unchanged*, not "not detected"),
   `scan://progress`, `scan://done`, `scan://skipped` → the skipped list. Pause
   and resume through the scan button, which is the only control that exists:
   `cancel_scan` is registered and wrapped but has no UI caller, so nothing can
   click it. Assertions advance past the **250 ms** patch window
   (`lib/scanPatchBatch.ts`) with fake timers.
3. **`convert`** — selection → `pickOutputDir` → `convert_tracks` →
   `convert://progress` → results, including the per-item failure that arrives
   as `error` inside an `Ok` value and must not render as success.
4. **`duplicates`** — dedupe after a scan → `DuplicatesModal`, which has no test
   file today → dismiss and `delete_album`. Modals portal into `document.body`
   through `Overlay.tsx`, so queries go through `screen`.
5. **`metadata`** — `suggest_metadata`, `cover_preview`, `write_metadata`, and
   the same failure-inside-the-value rule.
6. **`undo`** — write, then `undo_peek` → `undo_last`, and the old values back in
   the row. `docs/METADATA.md` names the detail worth asserting: `clear_empty`
   is `false` for a conversion and `true` for the editor and undo.
7. **`bandcamp`** — connect, collection, download progress, cancel. Not in G1's
   list; included because it is the chain carrying the most untrusted input.

**Layer 2**, in this order:

- **A spike first, before anything else is written.** Bring up
  `@wdio/tauri-service` with `driverProvider: 'embedded'` against a locally
  built `.app` and get one assertion to pass. Two unknowns: whether
  `tauri-plugin-wdio` needs an entry in a capability file (capabilities are
  collected at build time and are not Cargo-feature-aware), and whether
  `script-src 'self'` interferes with `browser.tauri.execute`. If either blocks,
  the fallback is `tauri-plugin-wdio-webdriver` alone — plain WebDriver, no
  `browser.tauri.*`, no capability entry. If that fails too, layer 2 is dropped
  from the session and recorded in `TODO.md` with the condition that would
  revive it, and layer 1 still ships whole.
- **`src-tauri/Cargo.toml`** — the wdio crates as **optional** dependencies
  behind a `wdio` feature, registered under `#[cfg(feature = "wdio")]`.
- **The guard that makes the warning enforceable**, next to that registration:

  ```rust
  #[cfg(all(feature = "wdio", not(debug_assertions)))]
  compile_error!("the wdio plugin exposes an HTTP automation server and must never be built into a release");
  ```

  `tauri build` compiles with `--release`, so a release bundle containing the
  automation server does not merely go unbuilt, it does not compile. Same shape
  as `sidecars_are_self_contained`: a rule the build enforces rather than a
  sentence in a document.
- **`scripts/e2e-app.mjs`** and **`src-tauri/tauri.e2e.conf.json`** — the
  isolation `dev-tauri.mjs` already proves, with a third identifier (`…-e2e`) so
  the run gets its own database, settings and undo history. The script
  regenerates the fixture with `dev-library.py --force` — idempotence is a trap
  here, because the BPM pass and `write_metadata` mutate these files and a rerun
  would inherit the previous run's writes — wipes the e2e app data directory,
  seeds `library_dir`, then builds. It never honours `REKORD_DEV_REAL`, the same
  rule `/run` follows.
- **`e2e/wdio.conf.ts`**, **`e2e/tsconfig.json`** and specs for the same flows,
  thinner: real files moving is the point, so `convert` and `undo` carry the
  weight. Vitest's `include` is `src/**` and `scripts/**`, so `e2e/` stays
  outside it and needs no config change; root `tsc --noEmit` does need one,
  because the specs bring mocha globals.
- **`.github/workflows/e2e.yml`** — `macos-14`, `workflow_dispatch` plus a
  labelled `pull_request`, not every push. `ci.yml` stays untouched: layer 1
  matches its existing `include` and rides in `npm run test:coverage` for free.

**`docs/TESTING.md`**, in the shape `docs/SCANNING.md` established (*How it
works* → *Deep technical details* → *Implementation anchors* → *Verification
links* → *Keeping this honest*), plus its line in `docs/README.md`: the three
test levels and what each is for, why `tauri-driver` is not an option, why the
wdio plugin is feature-gated and how the guard works.

## Verification

The four gates: `npx tsc --noEmit`, `npm test`, `cd src-tauri && cargo check`,
`cargo test`, and `cargo check --tests 2>&1 | grep -cE '^(warning|error)'`
printing `0`. Then `/code-review`, and **`/security-review`**, which this diff
triggers by definition: it adds a bundled dependency that runs an HTTP
automation server and may touch a capability file.

Three checks specific to this session, because a test suite that passes for the
wrong reason is worse than none:

- **The guard fires.** `cargo build --release --features wdio` must fail to
  compile, with that message.
- **The plugin is not in the bundle.** After a normal `npm run tauri build`, no
  wdio symbols in the binary and no listening port
  (`lsof -nP -p <pid> | grep LISTEN`).
- **Layer 1 goes red when the wiring breaks.** Rename a command in `lib/api.ts`,
  confirm a flow test fails; same for an argument's casing. That is the whole
  reason for mocking `invoke` instead of the wrapper.

Plus `REKORD_DEV_FRESH=1 npm run tauri dev` for a manual pass over convert and
undo, since those move real files, and `ps aux | grep tauri` before touching any
config — `pkill -f "tauri dev"` does not always get the whole tree.

## Order

One commit per step: this plan, then the spike's outcome (feature, guard,
`e2e-app.mjs`, config overlay) or its recorded rejection, then
`fakeBackend.ts`, then one commit per layer-1 flow, then the wdio specs,
`e2e.yml`, `docs/TESTING.md`, and last the roadmap entry — whose two counts are
stale (119 → 227 Rust tests, 32 → 49 frontend files) and which should carry the
platform fact — plus the `TODO.md` gaps this session closes and the changelog.

This file is deleted again in the release commit that cuts `0.7.2`.
