# rekord-lib

Desktop app (Tauri 2 + React 19 + Tailwind v4) that prepares audio files for
CDJ/XDJ and Rekordbox compatibility (conversion, metadata, duplicate detection,
Bandcamp download).

- Frontend: `src/` (Vite). Rust backend: `src-tauri/src/`.
- Dev/build run on **Node 22** (`.nvmrc`) — in the terminal, run `nvm use` if needed.

## Design & Branding — mandatory

The app has a **fixed visual identity**. All UI work follows the
styleguide, not ad-hoc design:

- **Single source of truth:** `src/styles/tokens.css` (Tailwind v4, CSS-first).
  Full styleguide: [`docs/brand/STYLEGUIDE.md`](docs/brand/STYLEGUIDE.md).
  Tokens are also available as TS: `src/styles/theme.ts` (for canvas/charts).
- **Colors only via tokens**, never the Tailwind default palettes
  (`neutral-*`, `sky-*`, `emerald-*`, …):
  - Surfaces/text/lines: semantic tokens `bg-bg`, `bg-surface`,
    `bg-surface-2`, `text-fg`, `text-fg-muted`, `text-fg-subtle`,
    `border-border`, `border-border-strong` (switch dark/light automatically).
  - Brand/action/progress: **accent violet** `accent-*`
    (primary `bg-accent-600`, hover `accent-500`).
  - Status = **compatibility** (semantic only, never decorative):
    compatible/done → `success`, conversion needed / metadata
    incomplete / warning → `warning`, error/delete/incompatible →
    `danger`.
- **Typography:** `font-mono` (JetBrains Mono) for data/labels/values/buttons
  (filenames, `44.1 kHz`, `24-bit`, format tags) — mono is deliberately prominent.
  `font-sans` (Inter) only for longer descriptive/help text. Sentence case,
  no Title Case / ALL CAPS. Weights only 400/500.
- **Shape:** controls `rounded-md`, cards `rounded-lg`, pills `rounded-full`.
  Border = hairline `border border-border`. Depth via `surface` levels, not
  via shadows. No gradients/glow, **one** accent.
- **Dark is the default** (`<html data-theme="dark">`).
- **Logo/icons:** `src/assets/brand/`, app icons `src-tauri/icons/`,
  web favicons `public/`. Never distort/recolor the logo or add effects.

In short: build new UI so that it does not stand out next to the existing UI — use
tokens, status color = state, mono for technical data. When in doubt, check
`docs/brand/STYLEGUIDE.md`.

Two skills belong here. **`/design`** is for trying layout variants on a canvas
before building one — allowed, but the result gets re-expressed in tokens, never
adopted as ad-hoc design. **`/design-system`** audits the system for
inconsistencies, documents a component, or works out a new pattern; reach for it
when the question is "does this already exist and what is it called" rather than
"what should this screen look like". Either way `tokens.css` plus the styleguide
stay the binding source.

## Workflow

**Every session starts with a plan, and the plan cuts the next version.** Write
it to a temporary `PLAN.md` in the repo root and commit it, so what a session set
out to do is in the history next to what it changed. Analyse which part of
`MAJOR.MINOR.PATCH` moves — at `0.x`, a bug fix or an internal improvement is a
**PATCH** (`0.6.0` → `0.6.1`), anything user-facing that is *new* is a **MINOR**
(`0.6.0` → `0.7.0`), and MINOR is also where a breaking change goes as long as
the version is below 1.0. Name the number in the plan and say why. The file is
deleted again in the release commit that performs the bump — it describes work in
flight, and once the version is cut the CHANGELOG entry says the same thing
better.

The plan proposes the version; it does not bump it. See **Releasing &
auto-update** — that still needs the maintainer's explicit go.

- After non-trivial changes: `npx tsc --noEmit` (frontend) and
  `cd src-tauri && cargo check` (backend) must be green — **including
  warnings**. Dead constants left behind by a refactor only show up as
  warnings, and a build that already prints some is a build where the next one
  goes unnoticed. `cargo check --tests 2>&1 | grep -cE '^(warning|error)'`
  should print `0`.
- Then, before committing: **`/code-review`** for correctness, or **`/simplify`**
  when the diff is only about reuse and clarity and there is no bug to hunt.
  Both read the working tree, so they run after the checks above are green.
- Commit/PR conventions as in the existing history (Conventional Commits).

## Persistence

Two stores, with a clear dividing line — keep new state on the right side of it:

- **SQLite** (`src-tauri/src/db/`, `rekord-lib.sqlite3` in the app data dir) holds
  everything that grows with the collection: `tracks`, `edits`, `fingerprints`,
  `duplicate_groups`. Written **from Rust**, incrementally — the scan persists
  each batch as it produces it, edits are written per row. Access it through the
  `db` module's functions, never with SQL from a command.
- **The JSON store** (`tauri-plugin-store`, `rekord-lib.json`) keeps only small
  config-shaped state: `settings`, `bandcamp_session`, `bandcamp_collection`,
  `bandcamp_downloads`. Every `save()` rewrites the whole file, so nothing that
  scales with the library belongs here.

Two rules that keep the caches honest:

- **Derived values are recomputed, never stored.** `compat` and
  `metadata_incomplete` come back from `compat::evaluate` /
  `TrackMetadata::is_complete` on read, so a rule change takes effect at once
  instead of leaving stale verdicts in rows.
- **Every cache states what invalidates it.** A track row is reused only while
  the file's mtime+size match (`db::needs_reanalysis`) and the app version is
  unchanged (`db::invalidate_on_version_change`); a fingerprint additionally
  depends on `fingerprint::ALGO_VERSION` — **bump that** when the decode window,
  sample rate or chromaprint config changes. A new cache needs the same
  treatment plus tests for its invalidation.

The legacy `library` key in `rekord-lib.json` is imported once
(`db::migrate`) and then left in place deliberately, so a downgrade still finds
its data. It can be dropped one release after 0.4.8.

## Testing — mandatory

- **Every new feature or change ships with matching tests.** Cover the new
  logic, not just the happy path (edge cases, empty/invalid input).
  - Frontend: Vitest + Testing Library. Test files live next to the code as
    `*.test.ts(x)`. Run with `npm test` (watch: `npm run test:watch`,
    coverage: `npm run test:coverage`).
  - Backend: Rust unit tests in a `#[cfg(test)] mod tests` next to the code.
    Run with `cd src-tauri && cargo test`.
  - **Flow tests** for anything that crosses the IPC boundary: `src/e2e/`, the
    real frontend against one fake backend wired in at `invoke`
    (`src/test/fakeBackend.ts`). They ride in `npm test`. A component test that
    mocks `../lib/api` cannot see a renamed command or a wrong argument name,
    because the wrapper never runs — that is what these are for.
  - **End-to-end**, when the change moves files or writes tags: `e2e/`, driving
    the built app. `npm run e2e` builds and runs it; `npm run typecheck:e2e`
    covers its types, which the root `tsc --noEmit` does not. Minutes, not
    seconds, so it is not part of the push gate — run it before a release.
    See [`docs/TESTING.md`](docs/TESTING.md) for what each level can and cannot
    answer for.
- Keep new logic **testable**: put pure logic in `src/lib/` (frontend) or a
  dedicated `mod`/function (backend) instead of burying it in large components
  or Tauri commands. Extract if needed (see `src/lib/grouping.ts`).
- Before finishing, in addition to `tsc --noEmit` / `cargo check`, both
  **`npm test`** and **`cd src-tauri && cargo test`** must be green. CI
  (`.github/workflows/ci.yml`) enforces this on every push/PR.

### Driving the real app — mandatory setup

Unit tests do not catch a broken wiring between a command and a view, so
non-trivial changes get clicked through in a running app. That run is **not** a
read-only observer: the scan writes BPM tags into files, the metadata editor
rewrites them, conversion and delete move files to the trash. So it never runs
against a real collection:

```sh
npm run tauri dev                      # generated library, own app data directory
REKORD_DEV_FRESH=1 npm run tauri dev   # rebuild it and wipe the devtest database
REKORD_DEV_REAL=1 npm run tauri dev    # deliberately, against your real data
REKORD_JOBS=2 npm run tauri dev        # force the analysis width (see audio::workers)
REKORD_DEV_UPDATE=1 npm run tauri dev  # fake a pending update (=critical / =important)
```

`REKORD_DEV_UPDATE` exists because a dev run has no updater endpoint, so the real
check can only answer "up to date" and the update dialog is otherwise unreachable
until a release. The wrapper passes it on as `VITE_DEV_UPDATE` — only that prefix
reaches `import.meta.env` — and `lib/devUpdate.ts` is guarded by
`import.meta.env.DEV`, so it is dead code in a build.

**`/run` drives the app through exactly these commands** and must never fall
back to `REKORD_DEV_REAL`. Everything below about stray `tauri dev` processes
applies to it unchanged.

There is nothing to remember: the `tauri` npm script is
`scripts/dev-tauri.mjs`, which intercepts **`dev` only**. It generates
`.dev/library` if needed (`scripts/dev-library.py`, gitignored), points the app's
`library_dir` at it, and adds `--config src-tauri/tauri.devtest.conf.json` — an
overlay that changes the bundle identifier to `-devtest`, so the app gets its own
database, settings and undo history and the installed app keeps working
alongside. `build` and every other subcommand pass through untouched, and the
release workflow uses tauri-action and never comes through here.

**Kill stray dev processes before changing `tauri.conf.json`.** A `tauri dev`
that outlives your terminal keeps watching the config and rebuilds on every
change — including a change to the identifier, which silently moves it onto the
real app data directory. That happened once: a leftover run migrated the
maintainer's real database to a newer schema, and because the old build reads
`bpm` as an integer where the new one stores a float, the installed app could no
longer load its library. No audio file was touched, but `pkill -f "tauri dev"`
does not always get the whole tree — check with `ps aux | grep tauri`.

Why it is worth having:

- **A symlink is not isolation.** The app follows it and writes into the
  original. This has already gone wrong once — a "Re-detect BPM" over a folder
  of symlinks rewrote the tempo tag in 42 files of the real library. Nothing was
  lost, because the detector produced the same values, but that was luck.
- **Generated files are better test data, not just safer.** They also make a
  scan finish in seconds instead of minutes. Each file in `dev-library.py`
  exists for one case — a click track at a known tempo, a
  fractional tempo, silence, a 3 s file, 96 kHz/24-bit, lossy, FLAC, an untagged
  file, a duplicate pair, non-ASCII and bracketed filenames — and the expected
  result is known by construction instead of measured. That set found a
  confident false tempo on steady tones within minutes of existing.
- **Real audio is for what only real audio can show:** actual tags, actual
  covers, and the tempo benchmark (`docs/DSP_BENCHMARK.md`), which needs real
  music with reference values and is a separate, read-only tool.

When a run does need real files, they are **copies** in `.dev/`, never the
library itself, and `git status` has to be clean before committing either way.

## Distribution, robustness & security — mandatory

The app ships as a **standalone `.app`** that must run on **any** supported Mac
**out of the box** — including machines that have **no Homebrew** and no way to
install system packages. Assume nothing beyond a clean macOS install; the user
should never have to install a dependency to make a feature work.

- **Self-contained binaries.** Every bundled sidecar / native dependency
  (`src-tauri/binaries/` — currently `ffmpeg`/`ffprobe`) must link **only
  against system libraries** (`/usr/lib`, `/System/…`). A binary linked against
  `/opt/homebrew/…` or `/usr/local/…` crashes with `dyld: Library not loaded`
  on users' machines — analysis/conversion then fail silently. **Never copy
  Homebrew binaries into the bundle**; use static builds. Regenerate them with
  `scripts/build-static-ffmpeg.sh` (minimal, audio-only, from pinned+checksummed
  sources) or the `Build ffmpeg sidecars` GitHub workflow. Verify before
  committing: `otool -L`
  shows system paths only, `file` shows the right arch, `codesign -dv` shows a
  valid (ad-hoc) signature. The test
  `audio::sidecar::sidecars_are_self_contained` enforces this in CI — keep it
  green, and add a matching guard for any new bundled binary.
- **Ease of installation.** First-run friction must stay minimal. The bundle is
  ad-hoc signed (`bundle.macOS.signingIdentity: "-"`) so Gatekeeper shows the
  bypassable "unidentified developer" prompt rather than the hard "is damaged"
  error. Ship the workaround for testers in the release notes (right-click →
  Open, or `xattr -dr com.apple.quarantine /Applications/rekord-lib.app`). The
  real target is Developer ID signing + notarization (see suggestions below) —
  ad-hoc is only the interim.
- **Security.** Only bundle binaries from trustworthy, verifiable sources, and
  vet them before they enter the repo (arch, signature, dependencies, size,
  version; prefer sources that publish checksums/signatures). Treat all
  downloaded / third-party content (Bandcamp downloads, dragged-in files,
  update artifacts) as **untrusted input** — validate and sandbox-scope it.
  Keep the Tauri capability, `assetProtocol`, and CSP scopes as **narrow** as
  the feature allows; widen only with a concrete reason. The updater's minisign
  signature is what protects auto-updates — never disable or bypass it.
- **`/security-review` is mandatory** for a diff that touches any of the above:
  untrusted input (Bandcamp downloads, dragged-in files, update artifacts), a
  bundled binary, or a capability / `assetProtocol` / CSP scope. Run it before
  the release, not after.

## Releasing & auto-update

**Never bump the version or cut a release without the maintainer's explicit
go.** Feature work and fixes land on `main` normally; a release is a separate,
deliberate step that only happens when the maintainer says so.

- **Distribution:** macOS **Apple Silicon only** (`aarch64-apple-darwin`; the
  bundled `ffmpeg`/`ffprobe` sidecars in `src-tauri/binaries/` exist only for
  that target — this is also why the backend CI job runs on `macos-14`, not
  Linux). The app is **ad-hoc** signed (`bundle.macOS.signingIdentity: "-"`) but
  **not** Developer-ID-signed/notarized — Gatekeeper still warns on first launch
  / after updates (bypassable "unidentified developer", not "is damaged"). See
  **Distribution, robustness & security** above.
- **Self-update:** Tauri updater + process plugins. Endpoint + public key in
  `src-tauri/tauri.conf.json` (`plugins.updater`), pure wrapper in
  `src/lib/updater.ts`, UI in `SettingsView` (About) + gear badge. The updater
  minisign keypair is separate from Apple signing; the private key is a GitHub
  secret (`TAURI_SIGNING_PRIVATE_KEY`, empty password), never committed.
- **The docs are checked and brought up to date before every bump** — not
  after, and not "next time". The bump is the last moment at which the
  documentation and the code are cheap to reconcile, because a released version
  is what someone will read the docs against. Walk the diff since the last tag
  and ask, per document, whether it still tells the truth:
  - **`docs/SCANNING.md`, `DUPLICATES.md`, `CONVERSION.md`, `METADATA.md`** —
    do the *Implementation anchors* still exist under those names, and does
    every *Verification links* row still name a test that exists? A renamed
    symbol or a deleted test makes the document wrong in exactly the way those
    sections exist to expose.
  - **`docs/COMMANDS.md`** — a new or changed command, argument or event.
  - **`docs/COMPARISON.md`** — a shipped feature means the *What we do not do*
    list gets shorter in the same release. A stale "we do not" is worse than no
    comparison at all.
  - **`TODO.md`** — an entry that is done leaves the file; a feature that
    shipped without part of itself creates one, with an id and a condition.
  - **`docs/FUTURE_CONSIDERATIONS.md`** — the item that just shipped gets its
    **done** marker and a *What shipped* paragraph.
  - **`docs/README.md`** — a new document gets its row; **`README.md`** and
    **`docs/CDJ_TEST_MATRIX.md`** if the feature set or a hardware claim moved.
  - **`CLAUDE.md`** itself, when the rule it states is no longer how the repo
    works.

  Only a genuinely unchanged document needs no edit, and saying which ones you
  checked is part of the release report. Numbers stay in the one document that
  measured them ([`docs/DSP_BENCHMARK.md`](docs/DSP_BENCHMARK.md),
  [`docs/CDJ_TEST_MATRIX.md`](docs/CDJ_TEST_MATRIX.md)) and are linked from
  anywhere else, so there is never a second copy to update.
- **Cutting a release** (only on go): bump the version in **three** places —
  `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` — run
  `cargo check` to sync `Cargo.lock`, turn the `CHANGELOG.md` entry into a
  dated version heading, delete the session's `PLAN.md`, commit, then tag **that
  commit by hash** and push the tag:

  ```sh
  git tag -a vX.Y.Z <release-commit> -m vX.Y.Z
  git push origin vX.Y.Z
  ```

  Run `/security-review` first (see above), and the docs pass above before that.
  `.github/workflows/release.yml` (tauri-action on `macos-14`) builds the dmg +
  updater artifacts + `latest.json` and publishes the GitHub Release.
- **Name the release commit; never tag `HEAD` implicitly.** `git tag -a vX.Y.Z`
  without a commit tags whatever is on top, and what is on top is not always the
  release commit — another session may have committed since, or the tag may be
  pushed a day after the bump. Then `release.yml` builds unrelated, possibly
  half-finished work into a published release with updater artifacts — and the
  number cannot be taken back and reused (see the last bullet). Not
  hypothetical: during 0.7.1 a parallel session's in-flight work sat on top of
  the release commit, and tagging by hash is what kept it out. Verify before
  pushing — `git log --oneline -1 vX.Y.Z` has to show the `chore(release)`
  commit.
- **The release notes are the changelog.** `scripts/release-notes.mjs` cuts the
  section for the tag out of `CHANGELOG.md` and the workflow passes it as the
  release body, which is also what lands in `latest.json`'s `notes` and what the
  updater shows. So a tag with no changelog section **fails the build** on
  purpose. A `**Severity:** critical` line under the version heading turns the
  in-app update banner red; `**Severity:** important` marks it yellow without the
  banner. Anything else, including a typo, ships as an ordinary release.
- **Immutable releases must stay OFF** (repo *Settings → General*) for the
  fully automatic publish (`releaseDraft: false`). If turned on, a published
  release rejects asset uploads — then use `releaseDraft: true` and publish the
  draft manually. A version tag, once used, cannot be reused (bump to the next
  patch instead).
