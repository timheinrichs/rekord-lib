# Plan · Discogs without an account, and no key on screen

**Version: 0.9.0 (MINOR).** New user-facing behaviour — suggestions without any
credential, a token as the way in — plus a breaking change to the
`discogs_credentials` / `set_discogs_credentials` commands. Below 1.0 both
belong in MINOR.

## Why

Two things, found the same evening:

1. **The consumer key was rendered in Settings** (`SettingsView.tsx`, next to
   "Stored in the Keychain"), because `DiscogsStatus` carried it. The reasoning
   was that the key is not the secret half and seeing it tells you which
   application is stored. It is still credential material, and Settings is the
   screen people screenshot — which is exactly how it left the machine.
2. **The barrier was needless.** The app asked for a registered Discogs
   *application* while only ever calling `/database/search`. Measured
   2026-08-26: that endpoint answers **unauthenticated** requests with HTTP 200
   and the four fields the chips are built from, at `x-discogs-ratelimit: 25`.
   Credentials raise it to 60, throttled per source IP — so a personal access
   token is worth exactly as much as an app registration and costs one copied
   string.

## What changed

- `metadata/discogs.rs` — `Credential::{Token, App}` with the `Authorization`
  header per form; `search` takes `Option<&Credential>` and runs anonymously
  without one; `refused` marks a 401/403 on an *anonymous* request, which is the
  day Discogs closes the undocumented open search.
- `secrets.rs` — a token account beside the pair, plus a non-secret
  `saved-at`. `replace` clears every form before writing the new one, so exactly
  one credential exists and a new pair can never be shadowed by an old token.
  `DiscogsStatus` loses `key` and gains `kind` + `saved_at`; the verdict is a
  pure `status_from`.
- `commands.rs` — `set_discogs_token` / `set_discogs_app_credentials` replace
  `set_discogs_credentials`; an anonymous refusal is recorded once per run in
  the event log.
- `metadata/net.rs` — the User-Agent said `0.1.0` on every release; it now comes
  from `CARGO_PKG_VERSION`.
- `SettingsView.tsx` — the block leads with "works without an account", takes a
  token first and key + secret behind a disclosure, and shows the stored
  credential as *form · date*, never as a value.

## Not in scope

OAuth 1.0a. It buys no limit, no data and no protection the app currently
lacks — see `docs/FUTURE_CONSIDERATIONS.md` **J2** for the condition that makes
it the right answer: the user's own Discogs collection.

## Verification

`npm test`, `cargo test`, `npx tsc --noEmit`, `cargo check --tests` (0
warnings), then the app itself: Settings shows no key, a token stores and shows
its date, and a track opened with **nothing** stored still gets Discogs chips.
`/security-review` before the release, `/code-review` before the commit.
