# Plan — the open advisories, as patch releases on 0.11

## Version

**0.11.0 → 0.11.1 → 0.11.2 (PATCH, twice).** Every open issue (#20–#41) is a
RustSec advisory opened by the `Audit` workflow. Nothing user-facing changes:
dependency updates and a narrower `zip` feature set are internal improvements,
which at `0.x` is a PATCH.

Cut from `release/0.11.x`, branched at `v0.11.0`, **not** from `main`: `main`
already carries step 1 of the 0.12.0 plan (`cue_points`, schema 12), and a patch
release must not ship half a minor — nor a schema an older build cannot read.
The branch is merged back into `main` afterwards, so the lockfile moves there too.

## 0.11.1 · The TLS and network stack

Lockfile only (`cargo update -p …`), no source change:

- `rustls` 0.23.45 → ≥0.23.46 — #25 #26 #27 #28 (0346–0349)
- `rustls-webpki` 0.103.15 → ≥0.103.16 — #38 (0382)
- `webpki-roots` 1.0.8 / `webpki-root-certs` 1.0.9 → ≥1.0.10 — #39 #40 (0381, 0383)
- `tokio` 1.53.0 → ≥1.53.3 — #41 (0386; the app never constructs an `AsyncFd`)
- `quinn-proto` 0.11.16 → ≥0.11.18 — #20–#24 (not compiled for macOS, but in the lockfile)

Plus `src-tauri/.cargo/audit.toml`: `zbus_names`, `zvariant`, `zvariant_derive`
(#35 #36 #37) are *unmaintained* only and reach the lockfile through the
Linux/Windows side of `tauri-plugin-opener`; `cargo tree --target
aarch64-apple-darwin -i` prints nothing for them. Accepted with that evidence and
a reopening condition, like the rest of that file.

## 0.11.2 · `zip` 2 → 9

#29–#34 (0367, 0368, 0369 — each filed twice, for `zip` 2.4.2 and 4.6.1). The
three are all in `ZipArchive::extract`, which `bandcamp::download::extract_zip`
does not call — it reads entry by entry, skips symlinks and never applies a mode
— so the app was not exposed. The upgrade happens anyway, and with
`default-features = false` plus deflate only: a Bandcamp album is deflate or
stored, and every other codec was decoder surface over untrusted input that
nothing used. That also removes `zstd`/`zstd-safe`/`zstd-sys` and their fourteen
new advisories (0391, 0395–0406, 0410) from the tree.

`zip` 4.6.1 stays in the lockfile through `tauri-plugin-updater` on Windows if no
newer updater drops it; it is not in the macOS tree, and is accepted the same way.

## Gate per release

`cargo check --tests` with zero warnings, `cargo test`, `npx tsc --noEmit`,
`npm test`, `cargo audit` clean, `/security-review`, docs pass
(`THIRD_PARTY_LICENSES.md` for the dependency moves), CHANGELOG section, then the
bump commit is tagged by hash.
