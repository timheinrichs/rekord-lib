# Plan — readable release notes, and the E security items

Two things this session: the update dialog stops printing raw Markdown, and the
open half of the *Security and distribution* section in
`docs/FUTURE_CONSIDERATIONS.md` (E2–E5) gets done. They travel together because
one `/security-review` covers all of it.

**Version: PATCH 0.7.2 → 0.7.3.** Nothing new appears in the app: the notes
become legible, downloads get limits, a scope narrows, a secret moves, CI grows a
scheduled check. Improvements to what already ships, not features. (The plan
proposes the number; the bump waits for the go.)

## A · Release notes that render

The update prompt at start-up and the About section in settings show the notes
exactly as they arrive: the changelog section for that version, raw in a `<pre>`.
So a user sees `### Fixed`, `- **A tempo written into the wrong file.**` and
`**Severity:** critical` as literal characters. The text is Markdown because the
changelog and the release page are — the app is the one place it lands
unrendered, and the place where the least technical reader meets it.

- `src/lib/markdown.ts` — a pure parser for exactly the subset the changelog
  uses: `##`/`###` headings, `-`/`*` bullets with wrapped continuation lines,
  paragraphs, and inline `**strong**`, `*em*`, `` `code` ``, `[text](url)`.
  Anything it does not know stays visible as its own text, so an unanticipated
  construct degrades to what is on screen today rather than vanishing.
- `src/components/ReleaseNotes.tsx` — renders those blocks in tokens: mono for
  the section headings and inline code, sans for the prose, one accent for links,
  weights 400/500 only. Links go through `plugin-opener`, and only `http(s)`: a
  release body is text that arrives over the network, so the scheme is checked
  before it is handed to the OS.
- `UpdateModal` and `SettingsView` use it in place of their `<pre>`.
- The `**Severity:**` marker is dropped from the rendered text
  (`withoutSeverity` in `changelog.ts`, which owns the marker's shape). The UI
  already says it as a tag or a banner; printing the raw marker underneath says
  it twice, in the one form nobody was meant to read.

No Markdown dependency. The subset is small, the input comes from a file we write
ourselves, and rendering goes through React nodes — never
`dangerouslySetInnerHTML`, so there is no HTML in a release body to sanitise.

## B · E2 — Bandcamp downloads are bounded and stay inside their folder

The one path where the app writes attacker-influenceable names and bytes into the
library. Four holes: the whole download is buffered in RAM with no cap; a ZIP
entry whose `file_name()` is `None` falls back to the *raw* entry name, and
`sanitize` leaves `..` intact, so a title of `..` escapes the destination; an
HTML error page is saved as an audio file; and nothing limits what a ZIP
extracts.

Streamed to a `.part` file next to the destination instead of into memory,
removed on success, error and cancel. Named caps for the download, the per-entry
and total extracted size and the entry count. `text/html` rejected. Entry names
sanitised to a basename with no raw fallback, symlink entries skipped, and every
output path asserted inside the album folder with the existing `is_inside`.

## C · E3 — the `assetProtocol` scope is the library folder, not `$HOME`

The only consumer is audio playback (`convertFileSrc` in `lib/player.tsx`);
covers come back from commands as data URLs. Everything playable lives under the
library folder — the table is loaded per `library_dir`, drag-in converts into it,
Bandcamp downloads land in it. So the static scope becomes empty and the library
folder is allowed at runtime (`asset_protocol_scope().allow_directory`), at
startup from the store and again when the folder changes in settings. Verified in
a real build, not in `tauri dev`.

## D · E4 — dependency auditing in CI

`.github/workflows/audit.yml`, weekly and on demand: `npm audit` for the
frontend, `cargo audit` against `src-tauri/Cargo.lock`. Both on ubuntu — they
read lockfiles, so unlike the backend job they need neither macOS nor the
sidecars. `THIRD_PARTY_LICENSES.md` is curated by hand, so it joins the
pre-release documentation pass in `CLAUDE.md` rather than getting a generator.

## E · E5 — the Discogs secret moves into the Keychain

Key and secret sit in plaintext in `rekord-lib.json` today and travel as
arguments on every `suggest_metadata` call. They move into the macOS Keychain
(`keyring`, Security.framework, no native dependency), keyed by the bundle
identifier so the `-devtest` build cannot read the installed app's entry.
`suggest_metadata` loses its two arguments and reads them itself; the store keys
are migrated once at startup and then deleted.

**Fail closed.** If the Keychain is unavailable — denied, or an ad-hoc-signed
update no longer matching the item's ACL — nothing falls back to the JSON store:
settings asks for the credentials again and Discogs suggestions stay empty until
then, while MusicBrainz keeps working. Whether the entry survives an
ad-hoc-signed update is the one thing only a real update can answer, and it is
the argument for E1.

## Tests

Per area, next to the code: the parser and the renderer (each construct, wrapped
bullets, a malformed link, the severity line, a `javascript:` link); the ZIP and
cap cases in `bandcamp::download`; the pure scope decision; the Keychain naming
and the migration decision. `suggest_metadata` losing two arguments is what the
metadata flow test exists to catch.

`/code-review` per commit, and `/security-review` for B, C and E before the
release.
