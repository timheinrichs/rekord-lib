# Plan — 0.10.0: the app shows its state and answers back

Three items from tier I of [docs/FUTURE_CONSIDERATIONS.md](docs/FUTURE_CONSIDERATIONS.md),
all reported by someone using the app. They are one theme: **the app should show
what state it is in and confirm what it just did.**

## Version

**0.9.3 → 0.10.0 (MINOR).** I1 and I5 refine surfaces that already exist, and on
their own they would be a PATCH. I7 does not: a transient message is feedback the
app did not have, and `CLAUDE.md` puts anything user-facing and *new* in MINOR
while the version is below 1.0. The plan proposes the number; the bump itself
needs its own go.

## I1 · An expanded group has to look expanded

**The measurement that decides the design.** Every tone step in this palette is
tiny — dark theme, same formula `src/styles/contrast.test.ts` uses:

| pair | ratio |
| --- | --- |
| `surface` ↔ `surface-2` (today's hover step) | 1.10 : 1 |
| `surface` ↔ `bg` | 1.06 : 1 |
| `bg` ↔ `surface-2` (hover inside a well) | 1.17 : 1 |

So "make the open head a step lighter" cannot work in any direction — it is the
change that already reads as closed. What makes a tone step legible is **area**:
a head plus the rows under it is a block with a sharp edge at each end, and an
edge that long reads at a contrast a single 64 px row does not. (The roadmap
entry says "a step lighter", which is a dark-mode assumption: in light mode
`surface-2` #ECECEF is *darker* than `surface` #FFFFFF. The tone is a role.)

**The well.** An expanded group drops its head row *and every row it contains*
to `bg`, one step below the panel they sit in. No rail, no second hairline, no
shadow, no new token. The chevron goes to `text-fg` when open. Hover stays
`hover:bg-surface-2` on every row including an open head — it is then the
largest hover step in the table, and the row-actions patch is a `surface-2`
rectangle that only disappears into a row that is exactly that tone.

Folder nesting is unbounded, so tone says *whether* a row is in a group and the
existing indent says *how deep*. That is also the argument against a fourth
tone: a ladder with three rungs can never be the depth signal.

Height-neutral by construction — only `bg-*`, `text-*` and `aria-expanded`
change, so the measured row heights behind the virtualized list do not move.
This is why the hairline the entry proposed is not in the scheme; it would also
draw a strong line exactly between the head and the rows it owns.

`aria-expanded` on the head `<tr>`: a state invisible to a screen reader is the
same defect one layer down.

## I5 · "Add to playlist" is a dialog, not a menu

**Settled: a second component**, `AddToPlaylistDialog.tsx`, not a mode of the
`PlaylistEditor` I3 shipped. What the two share is the shell (`Overlay`, already
shared by seven), a chrome string, and a text field. What they do not share is
the subject, the row semantics, the state model and the lifecycle — a mode would
make the props a union with six fields absent in each arm.

The dialog keeps the wording that earns its place: `+2`, `+1 of 4`, `already in`
on a disabled row. "New playlist…" becomes a standing action in the footer
rather than the last row of a list. The labels `New playlist…` and
`New playlist name` stay byte-identical, so a real regression test survives the
rewrite.

`Overlay` gains an optional `onClose` and Escape, with a stack so only the
topmost answers — `DuplicatesModal` already opens over `MetadataEditor`. The two
editors that hold unsaved typing deliberately do not get it. `PlaylistEditor`'s
rename field needs `stopPropagation` on its own Escape, or cancelling a rename
would close the dialog; that is the main regression risk in this item.

`AddToPlaylist.tsx` is deleted and `menuPlacement.test.ts`'s panel floor drops
with it — that assertion guards the glob against silently finding nothing, and
leaving it one deletion from failing turns the next deliberate removal into a
red test that says nothing true.

## I7 · An action that changed something says so

**The toast is not diffed out of the log. It is the log's own emit, grown a
payload.** `events::record` already emits *inside* itself, on the arm where the
row was written — so "nothing raises a toast without also being in the log"
stops being a convention and becomes a shape. Today the emit throws the
information away; it will carry `EventNotice { id, level, message, announce }`.

`announce` is not a column. A log reopened tomorrow has no use for "this was
shown once", and keeping the flag out of SQLite is what makes a restart unable
to replay five hundred of them.

A new `events::announce` marks an action's own answer; `record`, `warn` and
`error` keep their meaning, and all their existing call sites are background
problems rather than answers. Five commands gain one: export (already recorded,
now announced), playlist writes, delete, convert, metadata write — each
summarised by a pure function with no `AppHandle`, so it is unit-testable.
A playlist reorder says nothing: it is a drag whose result is under the pointer
that made it.

**Announce success and partial success; leave total failure alone.** All of them
already throw into the persistent danger banner, and a red toast beside a red
banner is the same sentence twice. Consequence, stated rather than discovered:
no danger toast fires in the shipped app.

A burst of 200 per-file scan events produces 200 notices with `announce: false`
and draws nothing. The wall is prevented where a scan is known to be a scan.

The messages appear top right under the header, `pointer-events-none`, four
seconds, no pause and no close button — every affordance added to a transient
message is a reason to look at it. `info` takes the accent, not green: the badge
already colours it that way, and the Semantic Colour Rule's own corollary says a
heads-up is not a compatibility verdict. The container is always mounted and
becomes the app's first app-level live region.

## What changes in the design system

`DESIGN.md` first, per `CLAUDE.md`: **The Well Rule**, a *transient message 60*
floor on the layer stack, the group head added to the table-row signature, and a
new Don't — do not write a resting state in the hover tone. Plus a correction:
the Tinted-Ring Rule's example uses a bare `text-warning-500` and claims the
`fg-warning` utility does not exist, which eleven shipped call sites and
`tokens.css` contradict.
