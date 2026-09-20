# TODO — deferred and declined

Item **F7** from [docs/FUTURE_CONSIDERATIONS.md](docs/FUTURE_CONSIDERATIONS.md):
a place for things that were considered and consciously **not** done, so the
same idea does not get re-litigated every few months.

**What belongs here and what does not.**
[docs/FUTURE_CONSIDERATIONS.md](docs/FUTURE_CONSIDERATIONS.md) is the roadmap —
things we *could* do, with a size and a reason. This file is the other half:
work that was split off, measured and rejected, or deliberately left undone.
Every entry says what it is, why not, and **what would change that**. An entry
leaves this file when it is done or when the condition it named has arrived.

Follow-up ids (`C1a`, `C2a`, …) are the ones the roadmap assigned when the
parent item shipped without them.

---

## Measured and rejected

### B4 · Analysing several windows per track

**What** — three 120 s excerpts spread over the track instead of the single one
at 0:30, reconciled by clustering: the largest group of agreeing windows wins.

**Why not** — it was built, measured and removed. It changed the outcome by
**one track out of 2175** at 2.9× the decode cost, and the tier it existed for
did not move at all: the 568 tracks whose Rekordbox grid wanders scored 73.1 %
within ±2 BPM either way. Where a track has one tempo, one window finds it;
where it has none, no single number is right. Numbers in
[docs/DSP_BENCHMARK.md](docs/DSP_BENCHMARK.md).

**What would change that** — the one real effect was on the *confidence*, not
the tempo: agreement between windows separates correct from wrong answers
noticeably better than a single peak does (mean gap 0.16 → 0.25). If the write
gate in `audio/bpm.rs` ever needs to be sharper, this is where to look — and
then it is a confidence mechanism, not a tempo mechanism.

### Log-compressing the chroma magnitudes

**What** — the standard second step in key detection, after per-frame
normalisation.

**Why not** — it broke every synthetic test case, and there was no measurement
that justified it over that objection. Per-frame normalisation, the other
standard step, *was* adopted and was worth 27 tracks.

**What would change that** — a measurement on the reference set that shows a
gain, plus an explanation for the synthetic cases.

### Narrowing the default tempo range

**What** — defaulting to 70–180 BPM instead of 60–200, the way comparable tools
do.

**Why not** — measured, and it does not help. 70–180 is indistinguishable from
the wide range (+8 tracks out of 2175, p = 0.45), and 90–180 is significantly
*worse* while leaving 22 tracks with no tempo at all. The presets exist as a
setting (**B5**) for a library that really does sit in one genre.

**What would change that** — a single-genre collection to measure on. The
reference collection spans 70–185 BPM and cannot test the case.

---

## Split off when the parent shipped

### C1a · The scan's BPM pass has no undo record

**What** — the BPM pass writes a tempo tag into every file it detects one for,
and nothing records what was there before.

**Why not** — it is additive by default: it only fills an empty BPM, so there is
usually nothing to take back. And undoing it through `write_metadata` would
rewrite *every* tag in the file, which is a heavier operation than the write
being undone.

**What would change that** — `force` re-detection, which does overwrite an
existing value. It needs its own narrow undo path next to `write_bpm`, not a
detour through the full write. See [docs/METADATA.md](docs/METADATA.md).

### C1b · A conversion is not machine-reversible

**What** — after a conversion the original is in the trash and the output is on
disk, and nothing ties the two together.

**Why not** — the reversible part is already true (the source goes to the trash,
never `remove_file`); what is missing is the record that would let the app undo
it for you.

**What would change that** — a user reporting a conversion they did not mean.
The pieces exist: `ConvertResult` names both paths, and the undo history is
already a database table.

### C2a · Dismissed duplicate groups do not survive a relocate

**What** — a dismissal is keyed by the smallest path in the group, so
re-pointing the library at a moved folder leaves the dismissals aimed at the old
paths and the groups come back once.

**Why not** — the rows themselves survive; only the "waved off" decision does
not, and it comes back exactly once. Rewriting dismissal keys inside
`library_relocate` is more moving parts than the symptom justifies.

**What would change that** — a group id that is not a path. See
[docs/DUPLICATES.md](docs/DUPLICATES.md).

### B8a · The tempo cannot be halved or doubled from the track surface

**What** — the one tempo error a detector makes systematically is the octave,
and it is the one a listener spots instantly. The surface says when a grid has
drifted from a hand-typed tempo, and it cannot offer the fix: `64.00` / `256.00`
buttons that write the corrected tempo and re-fold the anchor against it.

**Why not** — a tempo is a *metadata* edit, and that machinery belongs to
`LibraryView`: it owns the `edits` state, writes it with `saveEdit` and reports
it upward through `onEditsChange`. There is no way in. Writing from the surface
would leave the library table showing the old value until something reloaded it,
which is the kind of disagreement `usePlaylists` exists to prevent. The
arithmetic is already here and tested — `scaledTempo` in `src/lib/beatGrid.ts`
— so this is the plumbing and not the feature.

**What would change that** — an applied edit reachable from outside the library
view: either the edits move up beside the tracks in `App.tsx`, the way the
playlists did in 0.10.0, or `LibraryView` takes a callback that applies one.
The second is smaller and the first is probably right.

### The beat grid is drawn, but only on the track surface

**What** — the grid is drawn now, on the zoomed waveform of the track surface.
The 112 px waveform in the library row still shows none: at that scale the beats
of a 128 BPM track are under a pixel apart, which is what the previous version
of this entry was about.

**Why not act** — nothing legible fits. The options are a grid that is a solid
block, or the first beat alone as a single mark — and the second is a different
idea that nobody has asked for yet.

**What would change that** — a use for it. A mark on the row that said *this
track has a grid* would be a status, not a grid, and `StatusIcons` is where a
status belongs.

### I1a · A group head is clickable, but not operable from the keyboard

**What** — the head row carries `aria-expanded` now, so a screen reader is told
whether a group is open, and the well says it visually. What it still is not is
*focusable*: the row is a `<tr>` with an `onClick`, so it cannot be tabbed to,
and Enter and Space do nothing.

**Why not** — the obvious fix is a real `<button>` around the chevron, and the
chevron's column is `w-8` (`lib/columns.ts`, `tight: true`, with a comment about
the icon having already disappeared into a zero-width content box once). Every
button in this app is `h-9 w-9` when it is icon-only, and `buttonShape.test.ts`
enforces it — so the fix either widens a column that was deliberately narrowed,
or argues for an exception. That is a different question from the one I1 was
asked, which was whether the state is legible at all.

**What would change that** — a keyboard pass over the table as a whole. The
folder tree arguably wants `treegrid` semantics rather than a button per row,
and deciding that one row at a time is how a table ends up with three
conventions in it.

### I1b · Three expansion sets, and one of them does two jobs

**What** — `LibraryView` holds `expandedAlbums`, `expandedFolders` and
`expandedLabels`, three `Set<string>` with three identical togglers. The last
is also the playlists' set, keyed `playlist-${id}`, which its own comment admits.

**Why not** — behaviour-neutral, and it would have made the I1 diff unreadable
as "what changed on screen", which is the only way that item could be reviewed.

**What would change that** — the next change that touches expansion state at
all. It is a rename and a merge, not a redesign, and the tests that would cover
it (`grouping.e2e.test.tsx`) now exist.

### I7a · Every recorded event still reloads the whole log

**What** — `events://new` carries the row that was written, and `App.tsx` still
answers it with a full `loadEvents()`. A scan over two hundred unreadable files
is two hundred round trips for data the payload already had.

**Why not** — it was fixable in the same change and deliberately was not.
Touching `refreshEvents` while introducing the transient messages would have
made a regression in the badge indistinguishable from a regression in the
message, and the badge is the older of the two.

**What would change that** — a library big enough for the reloads to show, or
simply the next change in this area. The subscriber can prepend the notice and
cap at `MAX_EVENTS` instead, now that it is handed the row.

### I7b · Confirmations share a 500-row cap with the diagnostics

**What** — `db::MAX_EVENTS` is 500 and `push_event` prunes to it. Seven commands
now write an `Info` per run, so a long session of ordinary edits evicts the
warn and error rows the log was built for — "the ones the app survived
quietly", as `events.rs` puts it.

**Why not** — 500 rows is a lot of actions before it bites, and the two obvious
fixes both cost more than the symptom does today: a second retention rule means
two prunes and a column to branch on, and raising the cap makes the log slower
to read for the same reason it makes it longer.

**What would change that** — a report of a warning that should have been in the
log and was not. The cheap version is pruning `info` first and keeping the
problems to the cap, which is a `WHERE level = 'info'` in the same transaction.

### I8a · A playlist cannot be dragged onto another one

**What** — the playlists view has a sidebar of every playlist beside the open
one, which looks exactly like a drop target for the rows next to it.

**Why not** — it would put a second meaning on a gesture that already has one.
Inside the list a drag reorders; onto a sidebar row it would either move a track
between playlists or copy it into one, and there is no way to tell which is
meant from the gesture alone. "Put these somewhere" already has an answer that
says what it will do before it does it: the picker dialog, from a selection in
the library.

**What would change that** — somebody reaching for it and being surprised it
does nothing, plus a decision about copy versus move that a modifier key or a
drop menu could carry.

### I8b · A playlist does not say how long it is

**What** — the view's header counts tracks. A DJ set is measured in minutes.

**Why not** — `formatDuration` has no hours branch, so a three-hour set would
read "184:22", and fixing that in place would change the Length column too. It
needs a sibling `formatRuntime` and a decision about what a total means when
some entries are in another library folder and have no duration to add.

**What would change that** — the sibling function is half an hour; the decision
about incomplete totals is the part worth waiting for a real playlist to make.

### Skipping tracks can deadlock WebKit's audio session

**What** — skipping through a queue froze the app dead: the window stopped
responding and did not come back. Sampling the hung process showed the Tauri
side idle in its event loop and the **WebKit web process** blocked for good in
a synchronous IPC — `sessionCanProduceAudioChanged` →
`maybeActivateAudioSession` → `AudioSession::tryToSetActive` →
`Connection::sendSyncMessage` → `waitForSyncReply`.

**Why it is only mitigated** — the race is in the platform. Every `play()`
re-activates the audio session over that round trip, and the only lever from
here is how often it is asked. Track changes are coalesced now, so a burst of
skips activates the session once instead of once per skip, and
`src/lib/player.test.tsx` pins that. But one activation can still in principle
meet another — a track ending into an auto-advance while the user presses
next, say.

**What would change that** — a recurrence with the coalescing in place, which
would mean the frequency was not the whole story. The next thing to try is not
touching the session at all on a skip: one element that keeps its source and
seeks, or a silent pre-roll, both of which are larger than they sound. A
sample of the hung web process is the evidence to collect either way; the
stack above is what it looks like.

### The legacy `library` key in `rekord-lib.json`

**What** — the pre-SQLite library, imported once by `db::migrate` and then left
in place.

**Why not** — deliberately kept so a downgrade still finds its data.

**What would change that** — it may be dropped one release after 0.4.8. Nothing
reads it any more.

---

## Accepted advisories

`cargo audit` reports nine findings against this lockfile that will not be
fixed, and `src-tauri/.cargo/audit.toml` is the list, with the reason and the
reopening condition per id. Summarised here because that file is not somewhere
anyone browses.

### Nine RUSTSEC findings, none of them actionable

**What** — three advisories against crates that reach `Cargo.lock` only through
Tauri's Linux backend (`glib`, `event-listener`, `proc-macro-error`), and six
"unmaintained" notices against crates that really are in the macOS tree
(`paste`, and the five `unic-*`).

**Why not** — the first three are never compiled for `aarch64-apple-darwin`,
which is the only target; `cargo tree --target aarch64-apple-darwin -i <crate>`
answers "nothing to print" for each. The other six are unmaintained, which says
a crate has no maintainer rather than that it has a flaw, and none has a patched
release to move to — `paste` arrives through `lofty` and is still a dependency
of `lofty` 0.25.2, the `unic-*` family arrives with Tauri itself.

**What would change that** — any of the six becoming a real advisory rather than
an unmaintained notice; a parent dropping the dependency; or a second platform
becoming a target (**G2**), at which point the first three stop being
irrelevant and the two unsound ones need reading properly.

Worth recording separately, because it is the opposite of the above: the same
audit run surfaced **RUSTSEC-2026-0285**, a real TLS 1.3 handshake flaw in
`rustls` — in the macOS binary, under both `reqwest` and the updater — for which
no issue had been filed. It was fixed rather than accepted (0.23.42 → 0.23.45),
along with a yanked `chacha20`. A list of accepted findings is only honest if
the actionable ones are demonstrably not on it.

## Recorded because nobody else would notice

Found while writing the documentation, and not worth a change on their own.

### Four commands with no caller

`cancel_scan`, `cancel_dedupe`, `dedupe_status` and `dedupe_result` are
registered and wrapped in `src/lib/api.ts`, and no view calls them: the scan
button is pause/resume only. `start_scan(force = true)` — the deep re-probe that
bypasses the identity cache — is in the same position.

**Why not act** — a cancel button is a design decision, not a wiring gap, and
pause covers the case it would serve. Deleting the commands would be the wrong
move too; they are the reattach-and-abort surface a future control needs.

**What would change that** — a user asking to abort a run rather than hold it.

### Two mirrors that can drift

`norm_text` and `norm_album` exist in both `src-tauri/src/audio/dedupe.rs` and
`src/lib/dupAlbums.ts`, with no shared test asserting they agree. The metadata
tier of the duplicate search is likewise verified through a `meta_matches`
*mirror* of logic that is inlined in `find_duplicates`, so the test can pass
while the real code changes.

**What would change that** — a fixture list of input/output pairs both sides
assert against would cost little; extracting the tier into a callable function
would fix the second one properly.

### `STAGE_WAVEFORM` has no counterpart in `src/types.ts`

The stage labels are mirrored by hand, and this one was not carried over. It is
cosmetic today, and it is the exact shape that drift between the two sides
takes.

### `AUDIO_EXTENSIONS` exists twice

Once in `src-tauri/src/commands.rs` with a fixed array length, once in
`src/lib/api.ts` as a plain array. The Rust side fails loudly when the two get
out of step; the TypeScript side does not.

### `src/lib/dupAlbums.ts` is invisible to `grep`

It uses a literal NUL character as the separator in its folder-pair keys, which
makes `grep`, `file` and GitHub's diff view treat the file as binary. Search it
with `grep -a`. A printable separator that cannot occur in a path would remove
the trap; nothing depends on it being NUL.

### Four commands are `serde_json::Value` on one side and typed on the other

`edits_load`, `edit_set`, `duplicates_load` and `duplicates_save` are opaque
JSON in Rust while TypeScript asserts `TrackEdit` and `DuplicateGroup`. That is
deliberate — the shape belongs to the UI — but it is unchecked on both sides.

---

## Test coverage that is thinner than it looks

Collected while writing the *Verification links* sections, where a claim with no
test behind it has nowhere to hide.

**G1 has shipped and this table is what it left.** Two rows are gone:
`convert_tracks` is now driven end to end — a real conversion renamed over its
source, checked with ffprobe (`e2e/convert.spec.ts`) — and
`DuplicatesModal.tsx` has a flow test that pins which paths the panel offers to
delete (`src/e2e/duplicates.e2e.test.tsx`). What remains is narrower than it was,
because each of these is now *exercised* by a passing suite without being
*asserted* anywhere.

| Untested | Why it matters | What G1 changed |
| --- | --- | --- |
| `metadata::write::finalize` | end to end. Only `apply_cover` and the field mapping are tested, and this is the code that rewrites tags | runs on every metadata flow test and on the e2e scan, so a panic would be caught — a wrong tag would not |
| ~~`metadata/artwork.rs`~~ | *closed with C8.* `process_cover` and `already_cdj_shaped` are tested against generated images, including the round trip that says the encoder's own output is not re-encoded, and `write.rs` checks the restored bytes against a real file | — |
| `audio::dedupe::find_duplicates` | no test; it needs an `AppHandle` | the e2e run reaches it with real audio, but nothing asserts the tiers, so the `meta_matches` mirror can still drift |
| `convert_file`'s three cleanup branches | the failure paths that decide whether a half-written file is left behind | still unreachable: they need ffmpeg to fail mid-run, which no fixture provokes |

**Why not act** — each of these needs the failure *provoked*, not just the path
walked. A corrupt file that ffprobe accepts and ffmpeg chokes on would cover the
cleanup branches. (The cover row is struck through rather than removed because
the table is G1's record of what it left behind; what closed it was C8, which
needed those bytes for its own reasons.)

**What would change that** — a fixture built to fail. `dev-library.py` generates
files that work, on purpose; a second, smaller set built to break in a specific
way is the missing piece, and it is small.

### The e2e toolchain costs dependency surface

**What** — `@wdio/*` plus its transitive tree adds roughly 380 packages to
`node_modules` and takes `npm audit` from 5 findings to 14 (13 high). The roots
are `extract-zip` (via `@puppeteer/browsers`, which the embedded driver never
runs), `serialize-javascript` (via mocha), `deepmerge-ts` and `undici`.

**Why not act** — all of it is `devDependencies`. `npm audit --omit=dev` reports
zero, and nothing here enters the bundle, which is what the
*Distribution, robustness & security* rules in `CLAUDE.md` are about. The
alternative was dropping the whole second test layer, which would have given up
the only thing that can say the shipped app works.

**The decision E4 needed has been made.** The scheduled `Audit` workflow runs
`npm audit --omit=dev --audit-level=high`, so these 13 do not fail a job: they
are `devDependencies` and the rule they would be measured against is about what
ships in the bundle. The entry stays because the surface does — the audit simply
no longer has an open question attached to it.

**What would change that** — an advisory that turns out to be reachable from a
test run rather than only from a browser download the embedded driver never
performs; or `@wdio/*` becoming a runtime dependency, which it must not.

---

## Deliberately not adopted

Kept in
[docs/FUTURE_CONSIDERATIONS.md](docs/FUTURE_CONSIDERATIONS.md#deliberately-not-adopted)
rather than repeated here, because the arguments should exist in one place:
downloading an analysis engine at runtime, monolithic modules, shipping without
CI, unsigned updates, and a vanilla-JS frontend.

---

## Keeping this honest

- An entry needs the **condition** that would revive it. "Not now" without a
  trigger is a note, not a decision, and it is what makes a list like this rot.
- When an entry is done, delete it here and say so in `CHANGELOG.md` — the
  changelog is the record of what happened, this file is only the record of what
  deliberately did not.
- A roadmap item that ships *without* part of itself creates an entry here in
  the same commit, with an id, the way `C1a` and `C2a` were created — and it
  leaves again when that part ships, the way `C5a` did.
