# Plan — the cover cache, and undo that gives the bytes back

The rest of **C — Robustness and data safety**: C7 and C8, the last two open
entries in `docs/FUTURE_CONSIDERATIONS.md` and both also carried in `TODO.md`.
Closing them closes the block. They are the same file's artwork seen from
opposite ends.

**Version: PATCH 0.7.3 → 0.7.4.** Two bug fixes; nothing new appears in the app.
(The plan proposes the number; the bump waits for the go.)

## C7 · A cover cache that says what invalidates it

`CoverThumb` caches thumbnails in a module-wide `Map<path, dataURL>` and nothing
ever evicts an entry. Change or remove a cover and the old thumbnail stays on
screen until the app restarts: the row is right — a written file comes back
re-analysed, so `has_cover` is current — but the image is drawn from the cache
regardless, so a correct write looks like one that did nothing. It is also the
one cache in the app that does not say what invalidates it, which `CLAUDE.md`
requires of every cache.

The cache moves into `src/lib/coverCache.ts`, in the shape
`src/lib/waveformBatch.ts` already uses for the same problem: a module-level
store with subscribers and a `forget` that **re-asks for paths a mounted row is
still listening to**. Dropping the entry alone does not reach a row that already
asked, and that is exactly the bug. Three things invalidate, because three
things change artwork: a tag write and an undo (both arrive in
`applyWriteResults`), a conversion (which re-embeds the cover, often under the
same path), and a file the scan re-analysed because it changed on disk.

## C8 · Undo restores bytes; an ordinary write stops re-encoding

Undo does not restore the cover, it re-creates it: the snapshot keeps the
previous artwork as `CoverInput::Data`, and the restore hands it to
`process_cover` like any other new cover, which decodes it and re-encodes a JPEG
at quality 90. Nothing looks wrong — same dimensions, same rough size — but the
bytes differ, and undo is the one operation whose whole promise is that the file
ends up where it started.

So the undo snapshot marks its item `cover_verbatim` and `finalize` embeds those
bytes unchanged, with the MIME type sniffed from them rather than assumed to be
JPEG. An added field rather than a new `CoverInput` variant, deliberately: serde
ignores an unknown field, so an older build reading a newer undo entry
re-encodes the way it always did, while a new variant would fail to deserialise
there.

The same trip through the encoder happens on **every** ordinary write, because
`CoverInput::Keep` re-encodes the cover it just read, so repeated edits lose a
little each time for no gain. `artwork::already_cdj_shaped` answers whether the
bytes are already what `process_cover` would produce — a JPEG inside the edge
and byte budget, judged from the header rather than a decode — and `finalize`
skips the encoder when they are. Conservative: a PNG is still converted, and
anything unreadable goes through the encoder as before.

## Tests

`coverCache.test.ts` for the cache and its invalidation (a miss stays a miss
until forgotten; `forget` notifies a mounted listener; an unsubscribed one is
not called), a component test that the thumbnail changes without a remount, and
one flow-test assertion that the thumbnail is re-asked after a write — that is
what would catch the wiring being dropped. On the Rust side, `already_cdj_shaped`
against a cover we produced, an oversized one, a PNG and garbage; and, against a
real temp file, the claim undo actually makes: write cover A, replace it with B,
restore, and the bytes on disk are byte-for-byte A's.
