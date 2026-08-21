# Documentation

Every document under `docs/`, plus the ones at the repo root that belong with
them. One job each; nothing here ships with the app.

## Start here

| Document | What it answers | Read it when |
| --- | --- | --- |
| [COMPARISON.md](COMPARISON.md) | What rekord-lib is, what it deliberately does not do, and how it divides the work with Rekordbox | You are deciding whether this app solves your problem |
| [../README.md](../README.md) | Features, install, dev setup, release process | You want to run or build it |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | The rules, the checks, and how to run the app without damaging a real collection | You are about to change something |

## How the app works

One document per feature area, each in the same shape: *How it works* → *Deep
technical details* → *Implementation anchors* → *Verification links*. The last
two sections are the point — a symbol that no longer exists is a visibly stale
document, and a claim with no test named next to it has nowhere to hide.

| Document | Covers |
| --- | --- |
| [SCANNING.md](SCANNING.md) | The scan job's three phases, the incremental sync, pause and resume, and — the harder half — what invalidates which cache |
| [DUPLICATES.md](DUPLICATES.md) | The three matching tiers, why only the third one decodes audio, and why dismissals live in their own table |
| [CONVERSION.md](CONVERSION.md) | The five compatibility rules, what "compatible" actually claims, and what the conversion pipeline changes |
| [METADATA.md](METADATA.md) | Reading and writing tags, covers, suggestions, and what undo captures |
| [PLAYLISTS.md](PLAYLISTS.md) | Playlists as an explicit order, and the Rekordbox XML that carries them — plus the tempo, key and grid — out of the app |
| [COMMANDS.md](COMMANDS.md) | Every Tauri command and every event: arguments, return, what it emits, which wrapper calls it |
| [TESTING.md](TESTING.md) | The three test levels and where each one stops, why `tauri-driver` cannot be used here, and how the automation server is kept out of releases |

## Evidence and measurement

| Document | Covers |
| --- | --- |
| [DSP_BENCHMARK.md](DSP_BENCHMARK.md) | Our tempo and key detection measured against `stratum-dsp` and a 2180-track Rekordbox reference — including what the measurement could not settle |
| [CDJ_TEST_MATRIX.md](CDJ_TEST_MATRIX.md) | What has actually played on real hardware, and which scenarios have not been on a player at all |

## Direction

| Document | Covers |
| --- | --- |
| [FUTURE_CONSIDERATIONS.md](FUTURE_CONSIDERATIONS.md) | The roadmap: tiers A–H with stable ids, sizes, and what is already done |
| [../TODO.md](../TODO.md) | The other half — what was consciously not done, why, and what would change that |

## Design

| Document | Covers |
| --- | --- |
| [brand/STYLEGUIDE.md](brand/STYLEGUIDE.md) | The fixed visual identity: tokens, typography, shape, status colors |
| [brand/theme.ts](brand/theme.ts) | The tokens as TypeScript, for canvas and charts |

`media/` holds the README's screenshot and nothing else.

## Keeping this honest

A new document under `docs/` gets a row here in the same commit. A document that
nothing links to is a document nobody reads — which is how
[DSP_BENCHMARK.md](DSP_BENCHMARK.md) spent several releases reachable only from
`CLAUDE.md`.
