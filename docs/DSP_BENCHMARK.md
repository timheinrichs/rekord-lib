# DSP benchmark — our tempo detector vs. `stratum-dsp`

Item **B7** from [`FUTURE_CONSIDERATIONS.md`](FUTURE_CONSIDERATIONS.md): measure
the hand-written DSP in `src-tauri/src/audio/bpm.rs` against an off-the-shelf
crate, and keep whichever wins. Run on **2026-08-20** against
`stratum-dsp` 1.0.0.

## Verdict

**Tempo: we keep ours.** It is more accurate at every tolerance measured *and*
between 70× and 250× cheaper, both on identical input and when the crate is
given the whole track it is designed for.

**Key: not bought — written, and kept out of the files.** `stratum-dsp` gets
29.6 % of keys exactly right against Rekordbox where its own README claims
72.1 %. Ours reaches 35.6 %, which is better and still not a number to write into
someone's library: the key lives in the database only. Full numbers, and what
the three engines say about each other, in the key section below.

**Beat grid (B3): no evidence to adopt it.** Grid accuracy was not measured
directly, but the grid is built on the tempo estimate, and that estimate was
wrong more often than ours. Adopting the grid on the strength of this run is not
indicated.

`stratum-dsp` therefore stays out of `[dependencies]`. It remains a
`[dev-dependency]` so this benchmark keeps running and the decision can be
revisited against a future version.

## What was measured

- **Reference:** a Rekordbox XML export of the maintainer's collection, reduced
  to `src-tauri/tests/data/bpm_reference.csv` by
  `scripts/rekordbox-reference.py` — **2180 rows**, filenames hashed, every row
  carrying `AverageBpm`, the grid's internal drift, and `Tonality`. 2176 of them
  matched a file on disk.
- **Harness:** `src-tauri/tests/dsp_bench.rs`.
- **Same input for both engines** in the main run: the 120 s excerpt from 0:30
  that the scan actually uses, at each engine's preferred sample rate (11.025 kHz
  for ours, 44.1 kHz for the crate). Comparing our excerpt against a full-track
  analysis would have measured engine quality and input length as one number; the
  full-track case is a separate run below.
- **Two tiers**, split by how far the reference grid's own tempo wanders within
  the track. Where Rekordbox itself has no single tempo, a one-number detector
  cannot be scored as if it had.

## Tempo — 2176 tracks, identical 120 s window

### Steady grid (drift < 0.5 BPM) — 1608 tracks

The table that decides.

| engine | ±0.5 BPM | ±2 BPM | octave error | wrong | no result | decode | analyse |
|---|---|---|---|---|---|---|---|
| **ours** | **1359 (84.5 %)** | **1400 (87.1 %)** | 130 | 70 | 8 | 149 ms | **30 ms** |
| stratum-dsp | 1192 (74.1 %) | 1336 (83.1 %) | 197 | 73 | 2 | 118 ms | 2087 ms |

Our 87.1 % within ±2 BPM happens to land exactly on the 87.7 % the crate claims
for itself; the crate reaches 83.1 % here.

### Drifting grid (drift ≥ 0.5 BPM) — 568 tracks

| engine | ±0.5 BPM | ±2 BPM | octave error | wrong | no result |
|---|---|---|---|---|---|
| ours | 171 (30.1 %) | 415 (73.1 %) | 69 | 59 | 25 |
| stratum-dsp | 190 (33.5 %) | 409 (72.0 %) | 74 | 81 | 4 |

A tie, and both far worse — which is the tier behaving as expected rather than
either detector failing. Neither engine can match a wandering grid with one
number.

## Does the whole track help the crate? — 400 identical tracks

`stratum-dsp` documents itself as a full-track analyser, so it was also run that
way, on 400 steady-grid tracks, compared against the *same* 400 tracks from the
run above.

| engine / input | ±0.5 BPM | ±2 BPM | analyse |
|---|---|---|---|
| **ours, 120 s excerpt** | **83.2 %** | **86.2 %** | **30 ms** |
| stratum-dsp, 120 s excerpt | 74.0 % | 84.8 % | 2087 ms |
| stratum-dsp, whole track | 64.8 % | 81.8 % | 7516 ms |

**The whole track makes it worse**, not better, and costs 3.6× the analysis time
to do so. Key detection barely moves: 26.0 % exact on the full track against
24.5 % on the excerpt.

What this costs in the app is the real argument: at 30 ms per track our detector
analyses a 2200-track library in about a minute of CPU. At 7.5 s per track the
crate needs four and a half hours of CPU for the same work.

## Key — 2176 tracks

Only the crate appears here: we detect no key at all today, so the question was
never "is it better than ours" but "is it good enough to ship".

| exact | parallel (Am/A) | relative (Am/C) | fifth neighbour | wrong | no result |
|---|---|---|---|---|---|
| 644 (29.6 %) | 269 (12.4 %) | 165 (7.6 %) | 371 (17.0 %) | 721 (33.1 %) | 6 |

The error classes are kept apart because they mean different things. A *relative*
or *fifth-neighbour* key is what DJs treat as mixable, so those misses are mild.
A *parallel* key — right tonic, wrong mode — is not mixable and sits far away on
the Camelot wheel, but it says the chroma analysis found the right root and then
picked the wrong third; 12.4 % of the collection landing there points at the mode
decision, not at the pitch analysis.

Counting generously, roughly half of all keys land somewhere usable. A third are
outright wrong. That is not a number to write into thousands of files.

One trap found while building this: **`stratum_dsp::Key::numerical()` is not
Camelot.** Its convention is `A = major, 1A = C`; Rekordbox and Mixed In Key use
`A = minor, 8A = A minor, 8B = C major`. Using `numerical()` as a Camelot string
would put every track on the wrong spoke of the wheel. Camelot is derived from
the pitch class instead — see `camelot()` and its test in the harness.

## What the reference cannot tell us

Stated plainly, because these bound every number above.

- **Our detector was tuned on this collection.** The tempo prior in `bpm.rs`
  (centre 140 BPM, width 0.45 octaves) was fitted against 21 tracks from this
  same library, whose tempo mass sits at 110–150 BPM. `stratum-dsp` was tuned on
  Beatport/ZipDJ material. Part of our margin is therefore home advantage, and on
  a differently shaped library the gap would narrow. It would not invert the cost
  finding.
- **The reference range was 70–180 BPM**, our detector searches 60–200. A track
  whose real tempo is 185 cannot appear in the reference at 185 — Rekordbox
  folded it into range. **101 octave errors** across both tiers (ours 42, the
  crate's 59) answer outside 70–180 and therefore cannot be confirmed or refuted
  by this reference at all. This was written up as "the concrete argument for
  B5" — it was not. The sweep below ran our detector at 70–180, which removes the
  whole class by construction and gained nothing.
- **Rekordbox' answer depends on its settings.** Re-analysing the same
  collection after switching from *dynamic* to *automatic, high-precision grid*
  moved 1205 of 2180 tempo values, 90 of them by an exact octave. The reference
  is the best ground truth available, not an oracle — which is why octave errors
  are counted apart from wrong ones throughout.
- **Grid accuracy was never measured**, only tempo and key. The `<TEMPO>` nodes
  in the export would support that, and it is what B3 would need before adopting
  anyone's beat grid.

## The range and the window count — B5 and B4

Two follow-up experiments on the same 2176 tracks, both against the run above as
a baseline. Because the runs cover the *same* files, they are judged by counting
the tracks whose verdict changed rather than by comparing two percentages: a sign
test over the discordant pairs.

| configuration | ±0.5 BPM | ±2 BPM | wrong | no result | decode | fixed | broke | net | p |
|---|---|---|---|---|---|---|---|---|---|
| **60–200, one window** (baseline) | 85.0 % | 87.1 % | 68 | 8 | 137 ms | — | — | — | — |
| 70–180, one window | 84.3 % | 87.5 % | 59 | 10 | 149 ms | 46 | 38 | +8 | 0.45 |
| 90–180, one window | 82.5 % | 86.0 % | 77 | 22 | 138 ms | 50 | 76 | **−26** | **0.03** |
| 60–200, three windows | 85.2 % | 87.2 % | 66 | 7 | **432 ms** | 34 | 33 | +1 | 1.00 |

Percentages are the steady-grid tier; the paired counts cover all 2175 tracks
present in both runs.

The baseline row is a **re-run** of the wide range after the B2 work, not the run
at the top of this document — same configuration, so its numbers differ only by
which of two runs it was (85.0 % vs 84.5 % at ±0.5). The comparisons use the
re-run, because a paired test needs both sides measured by the same build.

### B5 — the range is a setting, not an improvement

Narrowing to 70–180 is indistinguishable from the wide range (+8 tracks out of
2175, p = 0.45). Narrowing further to 90–180 is **significantly worse**
(−26, p = 0.03) and leaves 22 tracks with no tempo at all, because their real one
has no representative inside the window.

The wide 60–200 default therefore stays — now for a measured reason rather than
caution — and the octave-wide presets ship as an option for a collection that
really does sit in one genre, which this one, spread over 70–185 BPM, cannot
test. Worth knowing before narrowing: the cost of a range that excludes a track's
real tempo is not a slightly worse answer, it is no answer.

**The sweep also refutes the reasoning this document offered.** Running at
70–180 removes the "unjudgeable octave error" class by construction — 42 of ours
become 0 — and the accuracy does not move. Those octave errors are genuine
detector mistakes that happen to land outside the window, not artefacts of the
range mismatch.

### B4 — several windows buy nothing

Three excerpts per track instead of one changed the outcome by **one track out of
2175**, at 2.9× the decode cost. The tier the idea existed for — the 568 tracks
whose Rekordbox grid wanders — did not move at all (73.1 % either way). The
premise, that a single window can be dominated by an atypical section, does not
hold here: where a track has one tempo, one window finds it, and where it has
none, no single number is right.

One real effect, too small to buy the cost: agreement between windows is a better
uncertainty signal than a single peak. The gap between the mean confidence of
correct and of wrong answers widens from 0.16 to 0.25, and the best achievable
write gate improves from 18 to 22 prevented wrong tags out of 337. The mechanism
was removed again rather than left in unused — this paragraph is what remains of
it, in case a future detector makes the idea worth re-measuring.

## Key detection — B1, written rather than bought

The crate's 29.6 % ruled out buying it, so the detector in `audio/key.rs` folds
the spectrum into twelve pitch classes and correlates that against each key's
expected pitch distribution. Three published profile sets were measured over the
same 2180 reference keys, because the literature disagrees and the choice is
cheap to settle:

| profile set | exact | parallel (Am/A) | relative (Am/C) | fifth | wrong | no answer |
|---|---|---|---|---|---|---|
| **Shaath** (shipped) | **774 (35.6 %)** | 12.4 % | 6.2 % | 11.6 % | 28.4 % | 128 |
| Krumhansl-Kessler | 690 (31.7 %) | 12.0 % | 5.9 % | 12.4 % | 33.6 % | 96 |
| Temperley | 604 (27.8 %) | 6.9 % | 8.7 % | 14.3 % | 36.3 % | 132 |
| stratum-dsp | 644 (29.6 %) | 12.4 % | 7.6 % | 17.0 % | 33.1 % | 6 |

Normalising each analysis frame before accumulating — so a loud drop does not
outvote three quiet minutes — was worth 27 tracks (69 fixed, 42 broken,
p = 0.013). Log-compressing the magnitudes, the other standard step, was
**dropped**: it broke every synthetic test case and there was no measurement to
justify it over the objection.

### The confidence is worth showing, and there is still no threshold

Unlike the tempo's, this confidence tracks correctness monotonically. Over the
2048 tracks where we produce a key and Rekordbox has one:

| confidence | tracks | exact | + mixable |
|---|---|---|---|
| 0.0–0.1 | 785 | 31.6 % | 54.0 % |
| 0.1–0.2 | 643 | 37.6 % | 56.9 % |
| 0.2–0.3 | 405 | 43.0 % | 59.3 % |
| 0.3–0.4 | 172 | 48.8 % | 61.0 % |
| 0.4–0.5 | 36 | 58.3 % | 61.1 % |
| 0.5+ | 7 | 71.4 % | 71.4 % |

From 32 % to 71 % across the range — a real signal, and the reason the number is
shown to the user rather than folded into a yes/no. But the volume sits at the
bottom: keeping only tracks above 0.3 leaves 10.5 % of the collection at 51 %
exact. There is no cut-off that is both accurate and covers a library.

### How good can this get? — what the three engines say about each other

The reference cannot be scored, since it *is* the reference. But two independent
detectors can be scored against each other, which bounds how much of the
disagreement is Rekordbox's fault:

| comparison | exact | + mixable |
|---|---|---|
| ours vs Rekordbox | 36.0 % | 55.1 % |
| stratum-dsp vs Rekordbox | 29.6 % | 54.3 % |
| ours vs stratum-dsp | 34.1 % | 62.5 % |

If Rekordbox were the odd one out, the two DSP detectors would agree with each
other far more than with it. They do the opposite: ours agrees with Rekordbox
(36.0 %) slightly *more* than with the crate (34.1 %). So the reference is
plausibly the closest of the three to the truth, and the gap is the difficulty of
the task rather than an error in the yardstick. Key detection on a broad
electronic collection is simply hard.

### Which is why the key is never written into a file

It goes into the database and the library view, with its confidence, and stays
there. A wrong `TKEY` is read by every other program and outlives the guess that
produced it, whereas a database value is replaced the moment a better detector
exists — the same reasoning that keeps `compat` recomputed instead of stored.

The reference project's own design agrees, which is worth recording because it
was initially read the other way: it has had key detection for longer than we
have, but its analysis results go into its own database and from there into the
Rekordbox export on the USB drive. It depends on `lofty` — the same tag library
we use, which can write — and never calls its write path (`save_to`,
`save_to_path` and `WriteOptions` appear nowhere in the repository). So a third
of a percent of accuracy is acceptable *in a layer you can throw away*, and the
feature's existence elsewhere says nothing about writing it into source audio.

## Beat grid phase — B3

The tempo detector says how fast; `audio/beats.rs` says *when*, by comb
filtering the same onset curve: for every candidate phase, sum the curve at that
phase and every beat period after it, and take the phase that collects the most.
Scored against the position of Rekordbox' first `<TEMPO>` marker, reduced modulo
the beat period — comparing raw seconds would be meaningless, since two grids can
name different beats and still describe the same grid.

| population | n | median error | ≤ 5 % of a beat | ≤ 10 % |
|---|---|---|---|---|
| **steady grid, tempo correct** | 1398 | **0.035** | 62.4 % | 75.1 % |
| steady grid | 1591 | 0.039 | 56.6 % | 69.3 % |
| drifting grid | 538 | 0.243 | 13.0 % | 22.5 % |
| all | 2129 | 0.064 | 45.6 % | 57.5 % |

The first row is the only fair one: where the reference grid wanders, its first
marker and our measurement window are at different phases by definition, so the
0.243 median says nothing about the detector. Where the comparison holds, the
median error is **0.035 of a beat — 16 ms at 128 BPM**.

That is enough for drawing beats over a waveform, where one bin of a five-minute
overview covers 125 ms and the error is invisible. It is **not** demonstrated to
be enough for ANLZ files (H1): 3.5 % of a beat is audible to someone beatmatching,
and half the tracks are worse than that.

One bug worth recording, because it is invisible in a tempo measurement. The
first version was 0.07 of a beat late on every click track — the onset curve lags
the audio, since a frame's flux peaks when the transient sits at the window's
centre and `onset_envelope` discards its first frame. The tempo detector never
noticed: it measures distances between peaks, where a constant lag cancels. An
absolute phase is the first thing that feels it. The initial correction had the
sign backwards and doubled the error to 0.13, which is how the sign was settled.

## Reproducing it

The reference set is committed; the audio is not. With the collection on disk:

```sh
cd src-tauri
REKORD_BENCH_DIR="$HOME/Music/Library" \
  cargo test --release --test dsp_bench -- --ignored --nocapture
```

`--release` is not optional: the profile override in `Cargo.toml` optimises
dependencies only, so a debug run times an unoptimised `detect_bpm` against a
fully optimised crate. `REKORD_BENCH_TIER`, `_LIMIT`, `_JOBS`, `_FULL_TRACK`,
`_MD` and `_CSV` shape the run — see the harness' module documentation. The
scoring logic itself is covered by ordinary unit tests that need no audio, so CI
keeps it honest.

Regenerating the reference after a new export:

```sh
scripts/rekordbox-reference.py /path/to/rekordbox.xml
```

Note that `REFERENCE_MIN_BPM`/`REFERENCE_MAX_BPM` in the harness record the
analysis range the export was made with. Change the range in Rekordbox and those
constants have to follow, or the report will excuse the wrong tracks.

## Consequences for the roadmap

- **B7 — done.** Documented evidence for keeping our own DSP, which is exactly
  the outcome the item was written for.
- **B1 (key)** loses its cheap path. Buying it is off the table; writing it
  (chroma/HPCP + Krumhansl templates) is the remaining option, and it is no
  longer blocked on a benchmark — the reference set for judging it now exists,
  with 2180 keys.
- **B2 (fractional BPM + confidence)** is unaffected and stays next: 1042 of the
  reference tempos are not integers, so the decimals we currently throw away are
  real information.
- **B3 (beat grid)** stays where it was, minus the assumption that a crate would
  provide it.
- **B4 (several windows) — measured and rejected**, see above.
- **B5 (BPM range) — shipped as a setting**, with the wide default kept because
  narrowing measured as no gain and one preset as a loss.
