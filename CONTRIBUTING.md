# Contributing to rekord-lib

Thanks for looking. rekord-lib is a small, opinionated app with one promise —
that a library it prepared plays on every Pioneer CDJ/XDJ without error codes —
and most of the rules below exist to protect that promise or the user's files.

Item **F3** from [docs/FUTURE_CONSIDERATIONS.md](docs/FUTURE_CONSIDERATIONS.md).

## Licensing: inbound = outbound

rekord-lib is [MIT](LICENSE) licensed. **By opening a pull request you agree
that your contribution is licensed under the same MIT license**, with no
additional terms. There is no CLA and nothing to sign.

Do not paste code from a source whose license you have not checked, and do not
add a dependency under a copyleft license without saying so in the pull request.
The distributed bundle already carries FFmpeg under LGPL/GPL, which is tracked
in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) — keep that file current
when you add or remove a dependency.

## Getting set up

Prerequisites, the dev commands and the build are in the README's
[Development](README.md#development) section: Node 22 (`.nvmrc`), Rust stable
with the macOS Tauri prerequisites, and the `ffmpeg`/`ffprobe` sidecars in
`src-tauri/binaries/`.

The app is **macOS on Apple Silicon only**. The sidecars exist for that one
target, which is also why the backend CI job runs on macOS rather than Linux.

## Running the app safely — read this before `npm run tauri dev`

**A dev run is not a read-only observer.** The scan writes BPM tags into files,
the metadata editor rewrites them, and conversion and delete move files to the
trash. So it never runs against a real collection:

```sh
npm run tauri dev                      # generated library, own data dir
REKORD_DEV_FRESH=1 npm run tauri dev   # rebuild it, wipe the devtest database
REKORD_JOBS=2 npm run tauri dev        # force the analysis width
REKORD_DEV_UPDATE=1 npm run tauri dev  # fake an update (=critical / =important)
REKORD_DEV_REAL=1 npm run tauri dev    # deliberately, against your real data
```

The plain `dev` command generates a small library under `.dev/library`
(gitignored), points the app at it, and runs with a `-devtest` bundle identifier
so it gets its own database, settings and undo history. An installed copy of the
app keeps working alongside it.

Three things worth knowing, all of them learned the hard way:

- **A symlink is not isolation.** The app follows it and writes into the
  original. A "Re-detect BPM" over a folder of symlinks once rewrote the tempo
  tag in 42 files of a real library. Nothing was lost, because the detector
  produced the same values — that was luck, not design.
- **Kill stray `tauri dev` processes before changing
  `src-tauri/tauri.conf.json`.** A run that outlives your terminal keeps
  watching the config and rebuilds on every change, including a change to the
  bundle identifier — which silently moves it onto the real app data directory.
  That happened once and left an installed app unable to read its own migrated
  database. `pkill -f "tauri dev"`
  does not always get the whole tree; check with `ps aux | grep tauri`.
- **When a run genuinely needs real files, use copies** under `.dev/`, never the
  library itself.

The generated library is also better test data than a real one: every file in
`scripts/dev-library.py` exists for a specific case — a click track at a known
tempo, a fractional tempo, silence, a three-second file, 96 kHz/24-bit, lossy,
FLAC, an untagged file, a duplicate pair, non-ASCII and bracketed filenames, and
four I–IV–V–I cadences in named keys — so the expected result is known by
construction rather than measured. That set found a confidently wrong tempo on
steady tones within minutes of existing, and the cadences promptly did it again:
held chords in D minor and E minor come back with a tempo nobody played.

A cadence rather than a single triad, because C–E–G shares two notes with A
minor and a detector given only that is being asked to guess. Everything else in
the library is a sine at 440 or a click at 220 Hz — which is to say A, over and
over — and a key column where every row agrees can show neither that grouping
and filtering work nor that a wrong answer is wrong.

## Tests are part of the change, not a follow-up

**Every feature or fix ships with tests that cover the new logic** — not only
the happy path, but the empty, invalid and edge cases too.

- Frontend: Vitest and Testing Library, test files next to the code as
  `*.test.ts(x)`.
- Backend: Rust unit tests in a `#[cfg(test)] mod tests` next to the code.

Keep new logic **testable**: pure logic belongs in `src/lib/` on the frontend,
or in a dedicated function or module on the backend, rather than buried in a
large component or a Tauri command. `src/lib/grouping.ts` is the pattern to
copy.

## The checks that have to be green

```sh
npx tsc --noEmit                 # frontend types
npm test                         # frontend unit tests
cd src-tauri && cargo check      # backend
cd src-tauri && cargo test       # backend unit tests
```

CI (`.github/workflows/ci.yml`) runs all four on every push and pull request.

The end-to-end suite is separate, because it builds the app and drives it:
`npm run typecheck:e2e` and `npm run e2e`. It runs on demand and before a
release, not on every push — see [docs/TESTING.md](docs/TESTING.md).

**Warnings count.** A build that already prints some is a build where the next
one goes unnoticed — dead constants left behind by a refactor show up here and
nowhere else:

```sh
cd src-tauri && cargo check --tests 2>&1 | grep -cE '^(warning|error)'   # must print 0
```

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), lower case, and
the subject says what the change *does* rather than what area it touched. The
history is the reference:

```
feat(updater): ask at start-up when an update is waiting
fix(library): fill in the waveforms of rows that were on screen during a scan
perf(analysis): budget the analysis width by cores and free memory
refactor(audio): clear the dead constants, and read stored waveforms
docs(scanning): explain the scan job and what invalidates each cache
test(library): harness for LibraryView, and a generated dev library
style(updater): a larger title, and critical as a tag next to the version
chore(release): version 0.7.0
```

Scopes in use include `library`, `analysis`, `audio`, `dedupe`, `metadata`,
`scan`, `updater`, `settings`, `player`, `ui`, `brand`, `dev`, `release`. One
topic per commit; a body is worth writing when the *why* is not obvious from the
subject.

Every user-visible change gets a [CHANGELOG.md](CHANGELOG.md) entry under `##
[Unreleased]`, in the style of the entries already there: a bolded opening
claim, then a sentence or two of explanation. The changelog **is** the release
notes — `scripts/release-notes.mjs` cuts the section for a tag out of it and the
release workflow publishes it, which is also what the in-app updater shows.

## Rules that are not negotiable

These protect either the user's files or the promise that the app runs on a
clean Mac.

- **Never copy a Homebrew binary into `src-tauri/binaries/`.** A binary linked
  against `/opt/homebrew/…` crashes with `dyld: Library not loaded` on a machine
  without Homebrew, and analysis and conversion then fail for reasons that look
  like anything but this. Regenerate the sidecars with
  `scripts/build-static-ffmpeg.sh` or the *Build ffmpeg sidecars* workflow, and
  verify before committing:

  ```sh
  otool -L src-tauri/binaries/ffmpeg-aarch64-apple-darwin   # /usr/lib and
  /System only file src-tauri/binaries/ffmpeg-aarch64-apple-darwin       # the
  right architecture codesign -dv src-tauri/binaries/ffmpeg-aarch64-apple-darwin
  ```

  The test `audio::sidecar::sidecars_are_self_contained` enforces this in CI. A
  new bundled binary needs its own guard like it.
- **Treat everything from outside as untrusted** — Bandcamp downloads,
  dragged-in files, update artifacts. Validate it and keep it sandbox-scoped.
- **Keep the Tauri capability, `assetProtocol` and CSP scopes as narrow as the
  feature allows**, and widen only with a stated reason in the pull request. A
  change to these needs verifying in a real build, not only in `tauri dev`.
- **Never disable or bypass the updater's minisign signature.** It is what makes
  an auto-update safe to install.
- **Deleting or replacing a user's file goes to the trash**, never
  `std::fs::remove_file`. This is someone's music.
- **Colors come from the tokens in `src/styles/tokens.css`**, never from
  Tailwind's default palettes, and status colors mean state rather than
  decoration. The authoritative styleguide is
  [docs/brand/STYLEGUIDE.md](docs/brand/STYLEGUIDE.md); new UI should not stand
  out next to what is there.
- **Do not bump the version and do not cut a release.** That is the maintainer's
  call, and it is a deliberate separate step — see
  [Releases](README.md#releases). Feature work lands on `main` normally.

## Where to read up before changing something

| Area | Document |
| --- | --- |
| The scan, and what invalidates which cache | [docs/SCANNING.md](docs/SCANNING.md) |
| Duplicate detection | [docs/DUPLICATES.md](docs/DUPLICATES.md) |
| Compatibility rules and conversion | [docs/CONVERSION.md](docs/CONVERSION.md) |
| Tags, covers, undo | [docs/METADATA.md](docs/METADATA.md) |
| The command and event surface | [docs/COMMANDS.md](docs/COMMANDS.md) |
| Tempo and key accuracy | [docs/DSP_BENCHMARK.md](docs/DSP_BENCHMARK.md) |
| What has been validated on real hardware | [docs/CDJ_TEST_MATRIX.md](docs/CDJ_TEST_MATRIX.md) |
| Ideas considered and not taken | [TODO.md](TODO.md) |
| Where this might go next | [docs/FUTURE_CONSIDERATIONS.md](docs/FUTURE_CONSIDERATIONS.md) |

An index of everything under `docs/` is in [docs/README.md](docs/README.md).

## Reporting a bug

The event log in the app (the header button) copies as text, and so does the
skipped-file list. Both are worth pasting into an issue — they carry the reasons
ffprobe actually gave, which is usually the whole answer. Include the app
version from *Settings → About*, and say whether the files came from Bandcamp, a
shop, or a conversion by another program.
