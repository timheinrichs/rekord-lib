# Playback, the waveform, and the beat grid

Items **I2** and **B8** from [FUTURE_CONSIDERATIONS.md](FUTURE_CONSIDERATIONS.md):
how the app plays a track, the two resolutions it draws one at, and the grid you
can now move.

The short version: the player bar is the whole track, the **track surface** is a
window on it, and the grid is two numbers — a period and a phase — of which the
app detects both and lets you correct one.

## How it works

**The player** is one hidden `<audio>` element in a provider at the root of the
app, streaming through Tauri's asset protocol. Its position lives in a context
of its own, updated about four times a second by the element, because the track
list must not re-render at that rate. Its volume is a setting rather than
session state: the only other way to change it is the system mixer, which
changes it for everything else on the machine too.

**The track surface** opens on the small waveform in a library row, or on the
expand button in the player bar. It is always the track the player is on — there
is no second piece of state saying which, so closing the player closes the
surface. It carries no transport and no overview: the bar below it already has
prev/play/next, the time readout and the whole track with a seek on it.

**The lane** is the zoomed waveform. The playhead sits at the centre and the
audio scrolls under it, at one of five spans stated as *how many seconds are on
screen* — at 128 BPM, 16 s is eight bars. Over the waveform: the beat grid, with
downbeats running the full height and plain beats starting below the ruler; in
the ruler, bar numbers where they fit.

**The grid** is drawn from the tempo and one anchor. In *move grid* mode the
lane drags; beside it are "set the anchor to the playhead", ±5 ms nudges, and a
1–4 control for which beat of the bar the anchor is. What you set is stored
apart from what the detector found, so *reset to detected* always has something
to go back to.

## Deep technical details

### Two resolutions, and only one of them is stored

The scan stores an overview: **2400 bins for a whole track**, about seven a
second on a six-minute one. That is sized for a player bar at most ~1500 px
wide, and it is an envelope rather than a beat.

A zoomed view needs to see individual transients, so it asks for the other
resolution — **200 bins a second, a 5 ms bin** — which is computed on demand and
stored nowhere. Three numbers say why 200: a beat at 128 BPM is 469 ms, so a bin
is a hundredth of one; the beat detector resolves no finer; and the Rekordbox
export writes an anchor to three decimals, so the picture stops a pixel short of
the precision the format can carry rather than pretending to more.

Raising the *stored* resolution instead would have bumped
`waveform::ALGO_VERSION`, invalidated every cached waveform and re-decoded the
whole library — for something only the open track ever needs.

The request says `"overview"` or `"detail"`, **not a bin count**. How many bins a
track needs is a function of its length, and the only side that knows that
length exactly is the one that has just decoded it. A count from the frontend
would mean mirroring the rate and its cap in TypeScript, applying them to a
probed duration that can be missing, and taking the size of a backend allocation
from the other side of the boundary.

The cap is `MAX_BINS = 120_000`, ten minutes at the full rate; a longer track
gets a longer bin. What sets that ceiling is the wire rather than the memory: a
waveform crosses as JSON, so the cap is about three megabytes of text to write
and parse, once per track opened.

### The decoded length travels with the bins

`Waveform.duration_secs` is how much audio the bins cover — the *decoded* length,
which is not the probed duration. A VBR MP3 can be a couple of hundred
milliseconds out, and a drawing that maps a bin back to a moment with the wrong
number stretches against a grid and a playhead that are exact. The player bar
never noticed, because it maps bins to a *fraction* of itself and never asks how
long the track is.

### Coarse first, then close

Opening a track draws the stored overview at once and replaces it in place when
the detail array lands. The grid lines and the playhead are already exact on top
of the coarse picture, because they come from numbers rather than from the
drawing. The coarse step reads **only** the stored overview: the on-demand
fallback would be a second full decode of the same file, finishing at the same
time as the first and buying nothing.

The caption under the lane reads the bins as well as the state, so "showing the
stored overview" is never claimed over an empty rectangle.

### One frame loop, and none under reduced motion

The playhead runs on the app's only `requestAnimationFrame` loop
(`usePlayhead`). It never calls `setState` — what it produces is pixels — and it
runs only while there is movement to draw: not paused, not behind the settings,
not when nothing is playing. A leaked frame loop is a permanent sixty wakeups a
second for a window nobody is looking at.

`DESIGN.md` requires every animation off under `prefers-reduced-motion`, and the
CSS rule that does it (`[class*="animate-"]`) cannot reach a canvas. So under
that preference the scrolling lane is **not mounted at all**: a second component
pages instead, drawing off the player's four-times-a-second progress into a
window that stands still and jumps on when the playhead leaves it. Every number
and every line is still there.

Per frame the lane does no column loop per fill: four `Path2D`s and four fills,
rather than four thousand state changes at the widest zoom on a retina display.
The palette is read once per theme rather than once per frame — `getComputedStyle`
forces a style recalculation, over a document that still holds the whole library
table behind the surface.

### A grid is a period and a phase

`tracks.beat_offset_secs` plus the tempo is the whole grid: the detector produces
one tempo per track, so there is no list of beat positions (`audio/beats.rs`
states that limit on purpose). The export writes it as
`<TEMPO Inizio Bpm Metro="4/4" Battito>`.

`Battito` says which beat of the bar the anchor is. Until the grid became
editable the app asserted `1` on every track, because the bar position is
precisely what the detector does not produce. It now says what somebody declared
— and falls back to 1 where nobody has.

> **Not yet verified against real hardware or a real Rekordbox.** No export this
> app has written with `Battito != 1` has been imported into Rekordbox or played
> from a CDJ. See [CDJ_TEST_MATRIX.md](CDJ_TEST_MATRIX.md). The always-valid
> fallback is to keep the 1 and move `Inizio` to the declared downbeat instead.

### Why a hand-set grid lives in its own table

`grid_edits` is keyed by path, the way `edits` is, and for the same reason: a
rescan rewrites the whole `tracks` row, and `invalidate_on_version_change`
re-probes every file once per release. A column on `tracks` would be only as
safe as every guard that remembered it, and a bug in a guard loses user data
permanently while a bug in an overlay merely fails to apply it.

Keeping them apart also leaves `tracks.beat_offset_secs` meaning exactly one
thing — what the detector last found — which is what *reset to detected* goes
back to. Nothing in the analysis path had to change for any of this.

Unlike `edits` it carries a foreign key. Cascade means a deleted track cannot
leave a row behind, and it means a `relocate_tracks` that forgets the table
fails at `COMMIT` rather than quietly dropping what somebody placed by hand.
`replace_track` **carries** it, which is the exception to that function's list of
what does not move: a conversion re-encodes the same music and does not move a
beat. The one case that gets wrong is a lossy source, where the decoder's
priming can shift the timeline by a few milliseconds — a few milliseconds the
user can see and correct beats silently discarding their work.

The tempo is **not** in that table. A corrected tempo is a metadata edit, which
the app already has, already writes into the file and already exports; storing a
second one here would be two tempos that can disagree.

### Folding the anchor rotates the bar

Every beat of a grid is the same grid, so a stored anchor is folded into the
first period — it keeps the number small and comparable, and it is what the
detector's own normalisation does.

The fold has to rotate the bar position with it, and that is the part that is
easy to leave out and impossible to see afterwards. Bar lines are counted from
the anchor, so moving it back *k* beats moves every line unless *k* is a
multiple of four: click "this beat is 3" at 30.25 s on a 125 BPM track, and the
beat you clicked is drawn — and exported — as beat 2. The lines stay evenly
spaced and still land on the music either way.

### Snapping, and the loop it must not close

A click on the lane snaps to the nearest beat within 40 ms, so you land on a
beat and hear the downbeat rather than the tail of the one before it. It is
deliberately **not** applied to "set the anchor to the playhead": snapping the
playhead to the grid and then setting the grid from the playhead is a loop that
moves nothing, and it is the bug in the first version of every grid editor.

### What the surface says when the tempo has moved under the grid

A phase is measured against a period. Change the period — type a tempo, or
correct an octave — and the beats walk away from the audio slowly enough that
the first bar still looks right. `GridEdit.bpm` records what the anchor was
placed against, and the surface says so rather than drawing a grid that is
quietly wrong. The tolerance is the twin of `GRID_TEMPO_TOLERANCE` in
`commands.rs`, which asks the same question of a detected phase.

## Implementation anchors

| Where | What |
| --- | --- |
| `src/lib/player.tsx` · `PlayerProvider`, `PlayerApi` | the element, the queue, `seek`, `currentTime`, the volume effect |
| … · `LOAD_COALESCE_MS` and the effect that uses it | the WebKit audio-session mitigation; do not fold it into anything |
| … · `ProgressCtx` | why the position is a second context |
| `src/lib/usePlayhead.ts` | the app's only frame loop, and its one cancel path |
| `src/lib/useReducedMotion.ts` | the query the CSS rule cannot apply to a canvas |
| `src/lib/gridLane.ts` · `laneWindow`, `pagedWindow`, `xAtTime`, `timeAtX`, `beatsInWindow` | which slice is on screen, and where the beats are in it |
| … · `ZOOM_SPANS`, `nearestSpan` | the ladder, stated in seconds across the window |
| `src/lib/gridCanvas.ts` · `drawLane`, `laneColours`, `RULER_PX` | the drawing, and the palette from the tokens |
| `src/lib/beatGrid.ts` · `effectiveGrid`, `foldAnchor`, `driftsFrom`, `snapToBeat` | which grid is in force, and the arithmetic of moving it |
| … · `scaledTempo`, `MIN_BPM`, `MAX_BPM` | the octave correction whose plumbing is `B8a` in [../TODO.md](../TODO.md) |
| `src/components/GridLane.tsx` | the two lanes, the drag, and the listeners it takes with it |
| `src/components/TrackView.tsx` | the surface, the controls, and the coarse-then-detail load |
| `src/components/VolumeControl.tsx` | one control, two places |
| `src/lib/detailWaveforms.ts` | the two-entry cache, and what sweeps it |
| `src/lib/useGridEdits.ts` | the overlay, loaded once and kept in step with what is written |
| `src-tauri/src/audio/waveform.rs` · `BINS`, `DETAIL_BINS_PER_SEC`, `MAX_BINS`, `detail_bins`, `Resolution` | the two resolutions and the cap |
| … · `analyze`, `reduce`, `to_bytes`, `ALGO_VERSION` | the decode, the reduction, the stored bytes |
| `src-tauri/src/audio/beats.rs` · `detect_beats`, `BeatGrid` | one period and one phase, never a list |
| `src-tauri/src/commands.rs` · `waveform`, `stored_waveforms` | on demand, and from the cache |
| … · `grid_edits_load`, `grid_edit_set`, `grid_edit_clear`, `check_grid` | the overlay's three commands and what they refuse |
| `src-tauri/src/db/schema.rs` · `grid_edits` | the table, its cascade and its `CHECK`s |
| `src-tauri/src/db/mod.rs` · `load_grid_edits`, `set_grid_edit`, `clear_grid_edit` | reading and writing it |
| … · `relocate_tracks`, `replace_track` | the two paths that have to carry it |
| `src-tauri/src/export/rekordbox.rs` · `track_xml` | where the overlay wins, and where `Battito` comes from |

Commands and their arguments are tabulated in [COMMANDS.md](COMMANDS.md).

## Verification links

| Claim | Test |
| --- | --- |
| The volume reaches the element before anything is loaded | `player.test.tsx` · "applies the level it is given, before anything is loaded" |
| A level outside 0..1 is folded in rather than thrown | `player.test.tsx` · "folds a level outside the range in rather than throwing"; `settings.test.ts` · "clamps a stored volume on the way in" |
| A drag writes the file a couple of times, not once a step | `playbackSettings.e2e.test.tsx` · "writes the file a couple of times for a whole drag, not once a step" |
| The level survives a reload | `playbackSettings.e2e.test.tsx` · "survives a reload" |
| The detail rate is 5 ms, and the cap bites before the allocation | `waveform.rs` · `the_detail_rate_resolves_five_milliseconds`, `a_long_track_gets_a_longer_bin_rather_than_more_of_them` |
| The resolution crosses as the word the frontend sends | `waveform.rs` · `the_resolution_arrives_as_the_word_the_frontend_sends` |
| The surface asks for the detail waveform by that name | `trackSurface.e2e.test.tsx` · "asks for a detail waveform, by that name" |
| Opening a track opens nothing else | `trackSurface.e2e.test.tsx` · "opens the track and nothing else" |
| The surface goes with the player it belongs to | `trackSurface.e2e.test.tsx` · "goes away with the player it belongs to" |
| A failed close look keeps the coarse one, and says which | `trackSurface.e2e.test.tsx` · "keeps the stored overview when the closer look cannot be had", "says so rather than claiming a picture it does not have" |
| The playhead is centred at both ends of the track | `gridLane.test.ts` · "keeps it there at the start of the track too" |
| Bars are numbered from the start of the file | `gridLane.test.ts` · "numbers the bars from the start of the track, not from the anchor" |
| A beat before a downbeat is beat 4, not beat 0 | `gridLane.test.ts` · "wraps the bar position backwards without a negative remainder" |
| The frame loop stops on unmount, and never starts under reduced motion | `usePlayhead.test.tsx` · "stops on unmount"; `GridLane.test.tsx` · "runs no frame loop at all when the machine has asked for less motion" |
| A drag takes its listeners with it, and only the primary button starts one | `GridLane.test.tsx` · "takes its drag listeners with it when it goes", "starts a drag on the primary button and no other" |
| Escape abandons a drag | `GridLane.test.tsx` · "puts the grid back when the drag is abandoned" |
| Folding keeps the beat somebody designated | `beatGrid.test.ts` · "keeps the beat somebody designated on the beat they said it was", "keeps it when a nudge wraps the anchor around zero" |
| A hand-placed grid wins, and its bar position is written | `rekordbox.rs` · `a_hand_placed_grid_wins_over_the_detected_one`, `battito_says_which_beat_of_the_bar_the_anchor_is` |
| A grid on a track the detector could not phase is still written | `rekordbox.rs` · `a_grid_placed_on_a_track_with_no_detected_one_is_still_written` |
| The reference reader reads our `Battito` back | `rekordbox.rs` · `what_we_write_is_read_back_by_the_reference_reader` |
| A rescan does not touch a hand-set grid | `db/mod.rs` · `a_rescan_does_not_touch_a_hand_set_grid` |
| A relocation and a conversion carry it | `db/mod.rs` · `relocate_keeps_identity_including_edits_grids_fingerprints_and_playlists`, `a_replacing_conversion_carries_the_row_and_its_playlists` |
| A conversion does not overwrite the target's own grid | `db/mod.rs` · `a_replacing_conversion_does_not_overwrite_the_targets_own_grid` |
| A bar position outside 4/4 is refused | `commands.rs` · `a_bar_position_outside_four_four_is_refused` |
| The surface writes an anchor the backend will take | `trackSurface.e2e.test.tsx` · "writes an anchor the backend will take, and reads it back" |
| Reset asks the backend to forget it | `trackSurface.e2e.test.tsx` · "puts a hand-set grid back on request" |

## Keeping this honest

A symbol in the anchors table that no longer exists is this document being
wrong, and it is meant to be visible. The same goes for a verification row whose
test has been renamed.

Two claims in here are **not** backed by a test and are marked as such: that
`Battito != 1` is read correctly by a real Rekordbox, and that a player does
anything sensible with it. Both need hardware, and until they have it the
honest place for them is [CDJ_TEST_MATRIX.md](CDJ_TEST_MATRIX.md).
