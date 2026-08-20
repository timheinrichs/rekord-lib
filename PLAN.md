# Plan · 0.7.0

Temporary. Deleted in the release commit that performs the bump — see
**Workflow** in `CLAUDE.md`.

## Version

**MINOR: 0.6.0 → 0.7.0.** F5 adds a user-facing capability (a severity banner
and release notes inside the app), and D3 changes visible behaviour and
introduces a new scan event, replacing how the tempo pass streamed its results.
Below 1.0 that is a MINOR, not a PATCH. D1 alone would have been a PATCH.

## Scope

Three roadmap entries from `docs/FUTURE_CONSIDERATIONS.md`, each size *S*, one
commit apiece.

- **D1 · Core- and memory-aware worker budget.** Replace three hard-wired eights
  with `audio::workers::budget` — the smaller of cores-minus-two and how many
  whole-file decodes fit in the free memory, asked per pass, capped at the
  measured value so it can only lower the width. `REKORD_JOBS` overrides it.
  `PROBE_CONCURRENCY` stays out: ffprobe reads headers, and the measurement next
  to that constant says the pass is bound by process startup.
- **D3 · Progressive row updates during the scan.** A `scan://patch` per finished
  file instead of a batch of whole tracks per chunk of eight. *Per field is not
  available* — one decode answers tempo, key and waveform together — so the
  granularity is per file. The real gain: a waveform-only result changes no
  column and was previously reported to nobody. Persistence stays batched per
  chunk, and the patches are collected in a 250 ms window because the table has
  no memoised rows.
- **F5 · Severity marking in the changelog.** `**Severity:** critical` under a
  version heading turns the gear badge red and states the update as a banner.
  Needs a producer too, which the roadmap entry did not say: the release workflow
  set no `releaseBody`, so the updater's notes were empty and there was no text
  for a marker to travel in. `scripts/release-notes.mjs` cuts the section for the
  tag out of `CHANGELOG.md`.

Plus two documentation passes: the skills (`/design`, `/design-system`,
`/code-review`, `/simplify`, `/run`, `/security-review`) anchored where the rule
they serve already lives, and this plan-and-version convention itself.

## Verification

`npx tsc --noEmit`, `npm test`, `cd src-tauri && cargo test`, and
`cargo check --tests 2>&1 | grep -cE '^(warning|error)'` printing `0`. Then
`REKORD_DEV_FRESH=1 npm run tauri dev` for D3 (rows filling in during a scan) and
D1 (`pgrep -c ffmpeg` following `REKORD_JOBS`). F5's end-to-end path only becomes
visible on the next real release; `node scripts/release-notes.mjs 0.7.0` checks
the producer locally.
