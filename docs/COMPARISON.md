# How rekord-lib compares

Item **F2** from [FUTURE_CONSIDERATIONS.md](FUTURE_CONSIDERATIONS.md): the
document that should tell a stranger in thirty seconds whether this app solves
their problem. Including the half that is easier to leave out — what it does not
do.

## In one paragraph

rekord-lib prepares a music library so that it plays on **every** Pioneer
CDJ/XDJ without error codes, and stays clean in Rekordbox. It converts what
players reject, fills in and checks the tags, finds duplicates across formats
and names, and downloads Bandcamp purchases straight into the library. It runs
locally on macOS and uploads nothing. It does **not** write the USB drive: the
files come out correct, and Rekordbox — or any other tool — takes them from
there.

## What we do not do

Stated first, because it is the fastest way to find out this is the wrong tool.

- **We do not build the USB drive.** No `export.pdb`, no `exportLibrary.db`, no
  ANLZ analysis files. Preparing files and writing a player database are two
  different jobs, and only the first one is ours today. Tracked as **H1**, and
  blocked on hardware rather than on effort: a database writer that has never
  been in a real player is a good way to ruin someone's set.
- **We do not write the musical key into your files.** It is detected and shown,
  and it lives in the database only. Our detector agrees with Rekordbox about a
  third of the time, and a wrong `TKEY` is read by every other program and
  outlives the guess that produced it. A database value is replaced the moment a
  better detector exists. Numbers in [DSP_BENCHMARK.md](DSP_BENCHMARK.md).
- **We do not claim a beat grid you can perform on.** The beat phase is
  detected, stored, and written into the Rekordbox export as a single `TEMPO`
  marker — it is *not* drawn under the waveform, which this document claimed for
  two releases and which was never true. The first downbeat is not detected at
  all (**B3**), so every marker says "beat 1" without knowing it, and a
  variable-tempo track gets one number like everywhere else.
- **We do not run on Windows or Linux**, and there is no plan to (**G2**). macOS
  on Apple Silicon, one target, because the bundled ffmpeg sidecars exist for
  exactly that one.
- **We do not upload anything.** MusicBrainz, Discogs and Bandcamp are contacted
  when a feature asks for it; the library itself never leaves the machine.

## What we do, that a tag editor does not

- **Playlists, and a Rekordbox collection to take them out in.** Playlists live
  in the app as an explicit order — the fifth grouping in the library table —
  and "Export for Rekordbox" writes a `rekordbox.xml` holding the whole library,
  every playlist, and per track the tempo, the key and a beat grid marker.
  Everything the app worked out arrives on the other side in one import instead
  of being retyped. See [PLAYLISTS.md](PLAYLISTS.md).

## Against Rekordbox

Rekordbox is not a competitor; it is the program most users will run *after*
this one. The division of labour:

| | rekord-lib | Rekordbox |
| --- | --- | --- |
| Repairing files players refuse | yes — resampling, PCM instead of AIFF-C, bit depth | no; it plays what it is given or complains |
| Writing the USB drive | no | yes, this is its job |
| Tag editing across a selection | yes, with suggestions and required-field checks | limited |
| Duplicate detection across formats | yes — length, acoustic fingerprint, name | by file, not by audio |
| Tempo and key | detected; tempo written into the tag when confident, key kept in the database | detected, and authoritative for the export |
| Beat grid | phase only, for display | full, editable, exported |
| Playlists | an explicit order, exported as `rekordbox.xml` | the core of the program |
| Cost and platform | free, MIT, macOS on Apple Silicon | free tier plus subscriptions, macOS and Windows |

The honest summary: **we fix the files, Rekordbox performs with them.** Anything
we detect that Rekordbox also detects, Rekordbox wins on — it owns the export,
and its numbers are the ones the player sees. What it does not do is repair a 96
kHz purchase into something a CDJ-2000 accepts, or tell you that three files in
three folders are the same track.

## Against tools that write the drive directly

There is a small family of open-source tools that write the Rekordbox export
database onto the stick themselves — the same stack we use, local-first, and
solving the adjacent half of the problem. They start where we stop.

If your problem is *"I want a stick that plays without Rekordbox in the loop"*,
that is what those tools are for, and the roadmap
([FUTURE_CONSIDERATIONS.md](FUTURE_CONSIDERATIONS.md)) records what we learned
from reading one of them, including the parts we deliberately did not adopt.

If your problem is *"my files are wrong"* — a 96 kHz download, an AIFF-C, half
the tags missing, three copies of the same track — that is this app, and no
amount of database writing fixes it.

The two overlap in analysis, and that is where we are ahead: we measured our
tempo detector against an off-the-shelf crate over 2180 reference tracks and
kept ours, at 87.1 % within ±2 BPM against 83.1 %, and roughly 70× cheaper. That
measurement, its limits, and the things it could not settle are in
[DSP_BENCHMARK.md](DSP_BENCHMARK.md).

## Against doing it by hand

The comparison most people actually make. By hand this is: run every file
through a converter, hope you picked the right sample rate and bit depth, retype
the tags in a tag editor, spot duplicates by squinting at filenames, and find
out on the player whether it worked.

What the app adds is not speed alone but **the verdict**: it says which files a
player would refuse and why, before the stick is in the machine — and the rules
it says it by are written down in [CONVERSION.md](CONVERSION.md), with what has
actually been validated on hardware in [CDJ_TEST_MATRIX.md](CDJ_TEST_MATRIX.md).

## Where the claims come from

Worth being precise about, since "runs without error codes on every CDJ/XDJ" is
a strong claim:

- The compatibility rules come from Pioneer's documented format limits, not from
  measurement — see [CONVERSION.md](CONVERSION.md).
- What has actually played on real hardware is recorded in
  [CDJ_TEST_MATRIX.md](CDJ_TEST_MATRIX.md). AIFF has run on a CDJ-2000nexus, a
  CDJ-3000 and an XDJ-700 through a Rekordbox export. The two cases the app
  exists for — resampling 96 kHz and converting AIFF-C — have **not** been on a
  player yet, and that file says so.
- The tempo and key numbers come from [DSP_BENCHMARK.md](DSP_BENCHMARK.md),
  measured against a 2180-track Rekordbox reference.

## Keeping this honest

- A feature landing here means the *What we do not do* list gets shorter in the
  same commit. A stale "we do not" is worse than no comparison at all.
- Numbers belong to the document that measured them. Link
  [DSP_BENCHMARK.md](DSP_BENCHMARK.md) rather than copying a percentage, so
  there is only one place to update.
- Comparisons to other tools stay about **capabilities and division of labour**,
  not about quality. We benchmarked a dependency, not a project.
