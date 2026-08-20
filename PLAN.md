# Session plan — the documentation layer (F1, F2, F3, F6, F7)

`docs/FUTURE_CONSIDERATIONS.md` calls tier **F** the area with the best return
per hour on the whole list, and it is the area where the least has been done. We
have a README, a styleguide, `CLAUDE.md` and two measurement reports. What is
missing is a place where a *behaviour* is explained once and completely.

Today that knowledge lives in commit bodies, in `CLAUDE.md`, and in roadmap
items that carry it as a subclause: what invalidates a cache, why FLAC is
flagged CDJ-3000-only, why the detected key is never written into a file. This
session closes five F items.

## Version — PATCH, `0.7.0` → `0.7.1`

Nothing here is user-facing and nothing is new in the app; it is an internal
improvement, which at `0.x` is a PATCH. The plan proposes the number, it does not
bump it — the release stays a separate, deliberate step.

## What ships

| Item | Result |
| --- | --- |
| **F1** | `docs/SCANNING.md`, `docs/DUPLICATES.md`, `docs/CONVERSION.md`, `docs/METADATA.md` |
| **F2** | `docs/COMPARISON.md` — what we are, and what we deliberately do not do |
| **F3** | `CONTRIBUTING.md` at the repo root |
| **F6** | `docs/COMMANDS.md` — the Tauri command surface |
| **F7** | `TODO.md` at the repo root — decisions consciously *not* taken |

Plus `docs/README.md` as an index, because eight documents with only ad-hoc links
from the README is how a document stops being read. `DSP_BENCHMARK.md` is
currently reachable from the README not at all.

## The shape F1 documents follow

*How it works* → *Deep technical details* → *Implementation anchors* →
*Verification links*, as the item specifies. The last two sections are the point:
a stale anchor is visible, and a claim with no test behind it has nowhere to
hide. Anchors name a file and a symbol, never a line number — a line number is
wrong after the next commit, a symbol name is not.

## Where the boundary to the roadmap runs

`FUTURE_CONSIDERATIONS.md` stays the roadmap: things we *could* do.
`TODO.md` collects what was considered and consciously not done — the measured
rejections (B4), the follow-ups that were split off rather than shipped (C1a,
C1b, C2a, C5a, C7, C8), and the test gaps this session found while collecting
verification links. Each entry states what would change the decision. The
reasoning is moved or linked, never argued twice.

## Verification

Documentation only — no code is touched. The real check is that the anchors are
real: every symbol named is confirmed against the tree, every test named exists
under that name, every relative link resolves. The four usual gates
(`tsc --noEmit`, `npm test`, `cargo check`, `cargo test`) must stay green; if a
documentation change moves them, code went along by accident.

## Order

One commit per document, plus this plan. `docs/COMMANDS.md` first, because its
facts are already collected; then the four F1 documents, `COMPARISON.md`,
`CONTRIBUTING.md`, `TODO.md`, the index, and finally the roadmap's done markers
and the changelog entry.

This file is deleted again in the release commit that cuts `0.7.1`.
