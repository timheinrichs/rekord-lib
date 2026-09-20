# Testing

Item **G1** from [FUTURE_CONSIDERATIONS.md](FUTURE_CONSIDERATIONS.md): how this
app is tested, and — the part that needed deciding rather than writing — where
each level stops. The roadmap entry's one-sentence argument is still the whole
argument: *unit tests do not catch a broken wiring between a command and a view.*

## How it works

Three levels, each answering something the level below it cannot.

```
unit                 pure functions, both sides of the IPC boundary
  src/lib/*.test.ts        grouping, filtering, formatting, the patch collector
  src-tauri/**/mod tests   compat rules, tag mapping, the tempo detector, db

flow                 the real frontend, a fake backend at the invoke boundary
  src/e2e/*.e2e.test.tsx   jsdom + mockIPC; App.tsx -> lib/api.ts -> invoke(…)
                           command names, argument casing, event shapes,
                           call order, empty and error states

end-to-end           the built app, driven through WebDriver
  e2e/*.spec.ts            a real window, the real Rust process, real files
                           tempo tags actually written, files actually moved
```

The first two run on every push (`.github/workflows/ci.yml`, about a minute).
The third builds a Tauri bundle and scans a generated library, which is minutes,
so it runs on demand and before a release (`.github/workflows/e2e.yml`, or
`npm run e2e` locally).

| Level | Command | Where the fake stops |
| --- | --- | --- |
| unit | `npm test`, `cd src-tauri && cargo test` | there is no boundary in it |
| flow | `npm test` (same run) | the Rust side is imaginary; every line of frontend is real |
| end-to-end | `npm run e2e` | nothing is faked; the app differs from the shipped one in three listed ways |

## Deep technical details

### `tauri-driver` does not exist on our only platform

The roadmap entry named WebdriverIO plus `tauri-driver`. That cannot be built
here: `tauri-driver` supports Windows through WebView2 and Linux through
WebKitGTK, and there is no WKWebView driver tool, so macOS — the only target we
ship — has no support at all. This is why G1 sat untouched rather than merely
unscheduled.

What replaced it is `@wdio/tauri-service` with `driverProvider: "embedded"`,
where the WebDriver server runs *inside* the app
(`tauri-plugin-wdio-webdriver`). It covers WKWebView, and the suite reports
`webkit … macos` when it runs.

### The automation server is a build that cannot ship

That plugin is remote control of everything the frontend can do, over HTTP. Its
own documentation says never to include it in a production build, and a rule that
depends on remembering is not a rule. So:

- the crate is an **optional** dependency behind a `wdio` Cargo feature,
- `lib.rs` carries `compile_error!` under `all(feature = "wdio",
  not(debug_assertions))`,
- `tauri build` compiles with `--release`.

A release bundle containing the server therefore does not merely go unbuilt — it
does not compile. `cargo check --release --features wdio` stops at that message,
and `e2e.yml` asserts that it still does, because a guard nobody checks is a
guard that quietly stops working after a refactor.

### `browser.tauri.*` is deliberately unavailable

The service's companion plugin, `tauri-plugin-wdio`, backs
`browser.tauri.execute`, command mocking and log capture. It evaluates its
scripts with `eval` inside the page, and our CSP has no `'unsafe-eval'`. Buying
that surface would mean running the suite against an app with a weaker CSP than
the one we ship, which is the wrong trade for a test whose whole purpose is to
say the shipped app works.

So the specs use plain WebDriver for the DOM and Node for the filesystem — which
is where the result of a conversion or a tag write actually is.

### Mocking `invoke`, not the wrapper

The component tests next to each view mock `../lib/api`. That is fine for what
they check, but it means the wrapper module never runs, so a renamed command, a
mistyped argument and a changed payload shape all pass.

The flow tests replace `invoke` instead (`mockIPC` from
`@tauri-apps/api/mocks`), so the whole frontend stack executes for real.
[COMMANDS.md](COMMANDS.md) is the contract they answer by, which turns a drift
between that document and the code into a failing test.

It reaches further than expected: every Tauri plugin talks over the same channel
(`plugin:store|get`, `plugin:dialog|open`, `plugin:updater|check`), and
`mockIPC`'s `shouldMockEvents` makes the real `listen` and `emit` work. So no
flow test needs a single `vi.mock` — the settings really are read through
`lib/settings.ts`, and the folder picker really is a dialog call.

Three conventions the fake exists to hold the app to, all three from
[COMMANDS.md](COMMANDS.md):

- **Arguments are camelCase, payloads are snake_case.** Tauri renames the
  former; nothing renames the latter.
- **A plain return type never rejects.** `write_metadata`, the three deletes and
  `bandcamp_download` report failure *inside* the value. `convert_tracks` too.
  A view that only handles a rejected promise renders a failure as a success,
  and that is what `failItem` is for.
- **Derived values are recomputed on read**, so the fake returns what the seeded
  track says and never tries to be clever.

### What a flow test cannot answer for

Stated here rather than papered over in a test:

- **`clear_empty`.** `commands.rs` chooses it per caller — `false` for a
  conversion, `true` for the editor and undo — and it never crosses the
  boundary. See [METADATA.md](METADATA.md).
- **Anything in Rust below the command.** The rename over the source, the
  `replace_source` trash and `convert_file`'s cleanup branches move files; that
  is the end-to-end suite's job and a Rust test's.
- **jsdom has no stylesheet.** Every main view stays mounted and the inactive
  ones are hidden with a Tailwind class so a scan survives navigation, which
  means every query finds one of everything per view. `src/test/appDom.ts`
  narrows — **by the name a view gives itself**, the `sr-only` `<h1>` that
  `AppHeader` renders, of which there is exactly one per screen. It narrowed by
  position until 0.10.0, which was only accidentally safe: inserting a view
  between two others re-points a helper at the wrong element with no type error
  and nothing failing until a dozen tests disagree about what they are looking
  at.
- **jsdom has no layout either**, which is worse than it sounds:
  `getBoundingClientRect` answers zero for everything, so *where* something
  landed is not a question this level can be asked. "Add to playlist" opened
  upward out of the header and was unreachable while its flow test clicked it
  happily — the panel was in the DOM, and that is all jsdom knows. Placement is
  therefore pinned twice, neither of them here: `menuPlacement.test.ts` reads
  the source for the spellings that cannot be right, and `e2e/menus.spec.ts`
  measures the real rectangle in the real window. That menu is a dialog now,
  and the spec measures both shapes: a menu has to hang below its trigger, a
  dialog has to be in the middle of the window whatever its trigger is doing.

### Tests that read the source instead of running it

A fifth kind, alongside the four levels above, and the only one whose subject is
the code as text: `src/styles/designRules.test.ts`,
`src/styles/disabledStates.test.ts`, `src/components/buttonShape.test.ts` and
`src/components/menuPlacement.test.ts`, sharing one scanner in
`src/test/classNames.ts`.

They exist because of a failure mode no other level has: what goes wrong is not
a broken component but a **new** one, written next to the old ones with the
wrong height, weight, radius or colour — and it renders perfectly. A component
test asserts what the component does, and the component does exactly what it
says. Only the collection has the defect.

So these read every `className` in the tree and assert the rules in
[`DESIGN.md`](../DESIGN.md) over it: every button is `h-9`, only weights 400 and
500, sentence case, text fields on the control radius, `disabled` never
expressed with `opacity`, a menu never anchored `bottom-full`, and — the one
that is a bug detector rather than a style rule — **every colour utility a
component writes must exist as a token**. That last one is there because a
missing utility is silent: `text-fg-warning` generated no CSS for several
releases and the element simply kept its inherited colour, which made an
uncertain tempo look more reliable than a sure one.

What they cannot answer for: whether the rule is the right rule, and anything a
value only acquires at runtime. They read text, so a colour computed in JS or a
class assembled from fragments is invisible to them — which is why the scanner
flattens `${…}` holes rather than guessing what is inside.

### The one test that does arithmetic

`src/styles/contrast.test.ts` is its own thing again: it reads both theme blocks
out of `tokens.css` and computes WCAG contrast for every pair the app actually
renders — text on the three surfaces, status text on its own 15 % tint, the
active tab label on its wash, a white label on each opaque fill, and the focus
ring at the non-text threshold.

It exists because this is the one class of claim a document cannot hold.
`DESIGN.md` said "plenty of contrast on small text" for two releases while
`warning-500` sat at 1.9:1 on a light surface, and nobody could have noticed by
reading. Two of the defects it now pins shipped anyway, in the release that
introduced it, because the table was incomplete rather than wrong: it asserted
text on *surfaces* and on *tints*, and a solid ramp fill is neither — which is
how a near-black label reached dark violet at 2.9:1. The lesson is in the file:
a contrast test is only as good as its list of pairs.

It also records what it deliberately does not assert, with the numbers —
`fg-disabled`, which WCAG exempts, and the two hairline borders, which are
below the 3:1 for the information that identifies a control and are an open
question rather than a settled exclusion.

### One test asserts a bug, on purpose

`metadata::write::tests::a_cover_larger_than_the_audio_still_panics_upstream` is
`#[should_panic]`, and what it pins is not our behaviour but **lofty's**: 0.25.2
subtracts where it should add when it rewrites an existing ID3v2 chunk in a RIFF
file whose new tag is larger than the whole audio stream, and the subtraction
underflows.

It is unreachable with real audio — a cover is never larger than its track, and
a 300 KB cover into the 5 MB `plain.wav` fixture was checked to come out intact
— but it was reachable with a 64-sample test fixture, which is why
`testing::wav_bytes` carries a second of silence and `testing::tiny_wav` exists
for this one test.

A test that asserts a defect is a canary, not a rule: when lofty fixes it, this
test fails, and that failure is the signal to delete it and shrink the fixture
back. Written down here because a `#[should_panic]` with no explanation is the
kind of thing a later reader deletes for the wrong reason.

### Isolation: three bundle identifiers

Nothing that runs a test may touch a real collection. A scan writes tempo tags,
the editor rewrites them, a conversion trashes the source.

| Run | Identifier | Library folder |
| --- | --- | --- |
| the installed app | `com.timheinrichs.rekord-lib` | yours |
| `npm run tauri dev` | `…-devtest` | `.dev/library`, generated |
| `npm run e2e` | `…-e2e` | `.dev/e2e-library`, regenerated per run |

Three identifiers mean three app data directories: three databases, three
settings files, three undo histories. Two differences between the dev script and
the e2e script are deliberate. There is **no `REKORD_DEV_REAL` escape hatch** in
`scripts/e2e-app.mjs`. And the fixture is regenerated with `--force`, because
`dev-library.py` leaves existing files alone on purpose — right for a dev run,
wrong here, where a rerun would otherwise inherit the previous run's tag writes.

### The e2e build is not quite the shipped build

Three differences, all in `tauri.e2e.conf.json` or the feature flag, and worth
knowing when reading a green run:

1. the `wdio` feature is on, so the app carries a WebDriver server,
2. a different bundle identifier and product name,
3. `createUpdaterArtifacts: false` — the signing key is not this build's
   business.

Everything else — the CSP, the asset protocol scope, the window, the sidecars —
is what ships.

### The CSP makes the suite slow, and that is the right way round

The service runs a window-focus check before *every* WebDriver command, and that
check goes through the same `eval` path as `browser.tauri.execute`. With no
`'unsafe-eval'` in our CSP it cannot run, so each command waits out a five-second
probe before continuing. Its warning says `core.invoke not available`, which is
misleading: the API is present and complete — verified directly — it is the
evaluation of the probe script that is blocked.

Two things were tried and rejected. `withGlobalTauri: true` changes nothing,
because the obstacle is `eval` and not the missing global. Adding
`'unsafe-eval'` to the e2e overlay would fix it and is exactly the trade this
suite must not make: a run that proves an app with a weaker CSP than the shipped
one proves the wrong app.

So the suite is minutes rather than seconds, which is affordable because it runs
on demand. Keep the number of WebDriver calls per spec low for the same reason —
a `waitUntil` that polls the DOM pays the probe on every poll, so a long interval
costs less than a short one.

**Run it alone.** The specs wait on real work — a scan analysing a 96 kHz file
is the most expensive thing the app does — so a machine also running `npm test`
and `cargo test` can push a wait past its timeout. That happened before the
0.9.3 release: `convert.spec.ts` failed on a busy machine and passed in 1m44s on
an idle one, which reads exactly like a regression in the conversion path and
was not. The timeouts are generous now for that reason, and a failure here is
still worth reproducing on a quiet machine before it is believed.

## Implementation anchors

| Where | What |
| --- | --- |
| `src/test/fakeBackend.ts` · `installFakeBackend` | the fake; one handler per command name, plus the plugin channels |
| … · `hold` | keeps a long-running command from answering, so the in-flight state is reachable |
| … · `failItem` | a failure *inside* a successful return |
| … · `restore` | leaves no-ops behind, because a listener may subscribe or unsubscribe after a test ends |
| `src/test/appDom.ts` · `libraryView`, `playlistsView`, `bandcampView`, `overlay` | narrowing a query to a view by the name it gives itself, or to the dialog on top |
| `src/test/factories.ts` · `makeTrack`, `makeMetadata`, `makeCompat` | the seed data, shared with the unit tests |
| `src/e2e/*.e2e.test.tsx` | one file per flow: first run, scan, convert, duplicates, metadata, undo, playlists, grouping, toasts, Bandcamp, theme |
| `src-tauri/src/lib.rs` · the `compile_error!` | the release guard |
| `src-tauri/Cargo.toml` · `[features] wdio` | the optional dependency |
| `scripts/e2e-app.mjs` · `prepare`, `build`, `writeManifest` | fixture, wiped data dir, debug bundle, and the paths the config reads |
| `e2e/wdio.conf.ts` | the embedded driver, and why the `browser.tauri.*` options are off |
| `.github/workflows/e2e.yml` | on demand and on an `e2e`-labelled pull request, never on every push |

## Verification links

| Claim | Test |
| --- | --- |
| A first fill goes through the scan job, so it can be watched and held | `firstRun.e2e.test.tsx` · "populates the library through the scan job, so the run can be watched and held" |
| The splash stays up instead of showing an empty table | … · "keeps the splash up instead of showing an empty table" |
| The header does not move while the library syncs | … · "keeps the header still while the library syncs" |
| A missing database does not take the boot down | … · "survives a library database that failed to open, and says so" |
| The button sweeps the folder; the backlog run does not | `scan.e2e.test.tsx` · "sweeps the whole folder rather than a list of paths" |
| A patch waits for the batching window, then lands | … · "holds a patch for the batching window, then applies it" |
| A `null` field means unchanged, not cleared | … · "treats a null field in a patch as unchanged, not as cleared" |
| Pause is not cancel | … · "pauses and resumes without cancelling" |
| A skipped file becomes visible | … · "makes a skipped file visible instead of quietly missing" |
| A library conversion asks for the source to be replaced | `convert.e2e.test.tsx` · "converts in place and asks for the source to be replaced" |
| A failure inside a success is not shown as success | … · "reports a failure that arrives inside a successful return" |
| A converted track is still in the playlist it was in | … · "keeps a converted track in the playlist it was in" |
| The panel offers exactly one deletion, never the kept file | `duplicates.e2e.test.tsx` · "trashes only the file the panel offers to delete" |
| A dismissal is stored apart and deletes nothing | … · "stores a dismissal apart from the result, and deletes nothing" |
| A save records the edit *and* writes it | `metadata.e2e.test.tsx` · "records the edit and writes it, in that order" |
| An unwritten value stays marked as unwritten | … · "reports a per-file write failure without claiming success" |
| Undo restores the tags from before the write | `undo.e2e.test.tsx` · "restores the previous tags and stops offering" |
| A failed download is not recorded as present | `bandcamp.e2e.test.tsx` · "reports a failed download instead of recording it as present" |
| The tempo is detected and written into the real file | `e2e/scan.spec.ts` · "writes the detected tempo into the file, not only into the database" |
| A conversion is renamed over its source, at the target rate and depth | `e2e/convert.spec.ts` · "rewrites the file in place, at the target rate and depth" |
| The window may read the library folder over `asset:`, and nothing else | `e2e/playback.spec.ts` · "plays a track from the library folder", "will not read an audio file outside it" |
| An opened menu is inside the window, below the header | `e2e/menus.spec.ts` · "hangs the column menu below its trigger, inside the window" |
| A dialog is centred, and its backdrop really covers the viewport | `e2e/menus.spec.ts` · "centres the playlist picker, and covers the window behind it" |
| …and no component spells a placement that could not be | `menuPlacement.test.ts` · the three cases |
| Every button is one height and one corner | `buttonShape.test.ts` · the 36 px Rule |
| Disabled is said in colour, never with `opacity` | `disabledStates.test.ts` · the Opacity Rule |
| Type stays on two weights and sentence case | `designRules.test.ts` · the Two Weights and Sentence Case rules |
| No component writes a colour utility no token defines | `designRules.test.ts` · "only writes colour utilities that tokens.css defines" |
| Nothing suppresses the shared focus ring | `designRules.test.ts` · "leaves the focus ring to the base layer" |
| Every animation stops under reduced motion | `designRules.test.ts` · "switches off every animation under reduced motion" |
| An opaque fill's label is fixed, not theme-dependent | `designRules.test.ts` · "puts a fixed label on a fixed fill" |
| Nothing blurs a surface a list scrolls under | `designRules.test.ts` · "does not blur behind a surface you cannot see through" |
| A year written before 0.9.3 still reads | `metadata/read.rs` · `the_year_reads_from_the_new_field_and_the_legacy_one` |
| The release country reaches the file | `metadata/write.rs` · `the_country_is_actually_written` |
| Every rendered colour pair clears WCAG AA, in both themes | `contrast.test.ts` · the 25 cases |
| The theme setting reaches `<html>`, and `system` resolves | `theme.e2e.test.tsx` · the three cases |
| An open group and everything it contains are in the well, in every grouping that folds | `grouping.e2e.test.tsx` · "opening a group puts it and its rows in the well" |
| An action says what it did, once, in the backend's words | `toasts.e2e.test.tsx` · "says what was added, in the backend's own words", "leaves the same sentence in the log" |
| What the log collects per file is never shown, and boot shows nothing | `toasts.e2e.test.tsx` · "stays quiet for what a scan collects per file", "raises nothing at boot, however full the log already is" |
| Nothing reaches the database without `db::require` | `commands.rs` · `nothing_reaches_the_database_without_require` |
| A release cannot contain the automation server | `.github/workflows/e2e.yml` · "The release guard still guards" |

Run them with `npm test`, `cd src-tauri && cargo test`, and `npm run e2e`. CI
gates the first two on every push; the third is on demand.

## Keeping this honest

- **A new command belongs in the fake's table** in the same commit. An unknown
  command throws by name rather than returning `undefined`, so this fails loudly
  — that is deliberate.
- **Never cast a payload shape in the fake.** Writing the three shapes down
  without a cast caught three wrong guesses before a test ran; an
  `as unknown as` would have hidden all of them.
- **A flow test that needs a change to a component is suspect.** The app's DOM
  is not wrong because a query is awkward: narrow the query instead. There are
  no `data-testid` attributes in app code, on purpose.
- **The three differences between the e2e build and the shipped build are a
  list that must not grow quietly.** Each one is a thing a green run does not
  prove.
- Anchors name a file and a symbol on purpose. If a symbol in the tables above
  no longer exists, that is this document being wrong, and it is meant to be
  visible.
