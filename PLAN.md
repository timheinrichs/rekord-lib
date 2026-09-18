# Plan — the roadmap only lists what is still open

## Version

**0.9.3 → 0.9.4 (PATCH).** Nothing user-facing changes: this is a documentation
and process rule plus the cleanup it prescribes. At `0.x` an internal
improvement is a patch.

## What

`docs/FUTURE_CONSIDERATIONS.md` had grown to 1683 lines, and roughly three
quarters of it was the record of finished work — 33 of 48 entries carried a
**done** marker and a *What shipped* paragraph. A roadmap that is mostly
history is one nobody reads to the end, and the same story was already told
better in `CHANGELOG.md`.

1. **`CLAUDE.md`** — the release docs pass now says a shipped entry is
   *deleted*, not marked done, and what happens to its id and its tier.
2. **`docs/FUTURE_CONSIDERATIONS.md`** — delete the 33 shipped entries; drop
   tiers B and C, which had nothing left, and their rows in the tier table;
   rewrite the cross-references that pointed at deleted entries; add a
   *Shipped* table of the ids at the end.
3. **`docs/README.md`** — its row for the roadmap said "and what is already
   done", which is now the opposite of true.

## Why the ids stay

`docs/COMMANDS.md`, `COMPARISON.md`, `TESTING.md`, `CONTRIBUTING.md`,
`DSP_BENCHMARK.md`, `TODO.md`, `src-tauri/tests/dsp_bench.rs` and
`.github/workflows/e2e.yml` all open with "item **X** from
FUTURE_CONSIDERATIONS.md". Deleting the entries without leaving the ids would
break every one of those, and the file itself promises the ids are stable. One
table row per tier keeps that promise at a fraction of the length.

## Not in scope

The follow-ups in `TODO.md` (`C1a`, `C1b`, `C2a`, the undrawn beat grid) stay
where they are — that file is already the record of what deliberately did not
happen, and its own rules say the same thing.
