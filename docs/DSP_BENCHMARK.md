# DSP benchmark — our tempo detector vs. `stratum-dsp`

Item **B7** from [`FUTURE_CONSIDERATIONS.md`](FUTURE_CONSIDERATIONS.md): measure
the hand-written DSP in `src-tauri/src/audio/bpm.rs` against an off-the-shelf
crate, and keep whichever wins. Run on **2026-08-20** against
`stratum-dsp` 1.0.0.

## Verdict

**Tempo: we keep ours.** It is more accurate at every tolerance measured *and*
between 70× and 250× cheaper, both on identical input and when the crate is
given the whole track it is designed for.

**Key: not bought.** `stratum-dsp` gets 29.6 % of keys exactly right against
Rekordbox, where the crate's own README claims 72.1 %. Writing that into
users' files would be worse than writing nothing, so **B1 does not get solved by
adding a dependency** — it is either written ourselves or deferred.

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
  by this reference at all. That is the concrete argument for **B5**: narrowing
  our range to match would remove a class of disagreement outright, and the
  harness can now measure whether it does.
- **Rekordbox' answer depends on its settings.** Re-analysing the same
  collection after switching from *dynamic* to *automatic, high-precision grid*
  moved 1205 of 2180 tempo values, 90 of them by an exact octave. The reference
  is the best ground truth available, not an oracle — which is why octave errors
  are counted apart from wrong ones throughout.
- **Grid accuracy was never measured**, only tempo and key. The `<TEMPO>` nodes
  in the export would support that, and it is what B3 would need before adopting
  anyone's beat grid.

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
- **B4 (several windows)** is back on the table. It was going to be redundant if
  a full-track engine won; no full-track engine won.
- **B5 (BPM range)** is promoted from convenience to a measurable fix, with 101
  affected tracks as the baseline.
