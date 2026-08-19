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

## Workflow

- After non-trivial changes: `npx tsc --noEmit` (frontend) and
  `cd src-tauri && cargo check` (backend) must be green.
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
- Keep new logic **testable**: put pure logic in `src/lib/` (frontend) or a
  dedicated `mod`/function (backend) instead of burying it in large components
  or Tauri commands. Extract if needed (see `src/lib/grouping.ts`).
- Before finishing, in addition to `tsc --noEmit` / `cargo check`, both
  **`npm test`** and **`cd src-tauri && cargo test`** must be green. CI
  (`.github/workflows/ci.yml`) enforces this on every push/PR.

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
- **Cutting a release** (only on go): bump the version in **three** places —
  `package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` — run
  `cargo check` to sync `Cargo.lock`, add a `CHANGELOG.md` entry, commit, then
  `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.
  `.github/workflows/release.yml` (tauri-action on `macos-14`) builds the dmg +
  updater artifacts + `latest.json` and publishes the GitHub Release.
- **Immutable releases must stay OFF** (repo *Settings → General*) for the
  fully automatic publish (`releaseDraft: false`). If turned on, a published
  release rejects asset uploads — then use `releaseDraft: true` and publish the
  draft manually. A version tag, once used, cannot be reused (bump to the next
  patch instead).
