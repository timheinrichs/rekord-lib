#!/usr/bin/env bash
#
# Build minimal, self-contained static ffmpeg + ffprobe sidecars for the app.
#
# WHY: the sidecars in src-tauri/binaries/ must run on any Mac with a clean
# macOS install — no Homebrew, no way to install packages (see CLAUDE.md,
# "Distribution, robustness & security"). A stock Homebrew ffmpeg links against
# /opt/homebrew/... dylibs that don't exist on users' machines. This script
# produces an audio-only, statically linked build that depends on system
# libraries only (/usr/lib, /System/...), verified with otool afterwards.
#
# The app never uses ffmpeg for images/video — cover art is read via lofty and
# the Rust `image` crate — so all video/image codecs are dropped, which is what
# shrinks the binary from ~50 MB down to a few MB and reduces attack surface.
#
# Usage:  scripts/build-static-ffmpeg.sh
# Result: overwrites src-tauri/binaries/{ffmpeg,ffprobe}-aarch64-apple-darwin
#
# Requirements (macOS arm64): Xcode Command Line Tools, plus `nasm`/`yasm` are
# NOT needed for an audio-only arm64 build. Everything else is fetched here.

set -euo pipefail

# ---------------------------------------------------------------------------
# Pinned sources. FFmpeg is cloned from the official git mirror at a fixed tag
# (provenance via https + the tag). LAME (needed for MP3 encoding) is a tarball
# verified against scripts/ffmpeg-sources.sha256 — verify that hash against the
# official SourceForge download the first time you touch this file.
# ---------------------------------------------------------------------------
FFMPEG_TAG="n7.1.1"
FFMPEG_GIT="https://git.ffmpeg.org/ffmpeg.git"
LAME_VERSION="3.100"
LAME_URL="https://downloads.sourceforge.net/project/lame/lame/${LAME_VERSION}/lame-${LAME_VERSION}.tar.gz"

TARGET="aarch64-apple-darwin"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT/src-tauri/binaries"
CHECKSUMS="$ROOT/scripts/ffmpeg-sources.sha256"
WORK="$(mktemp -d)"
PREFIX="$WORK/deps"           # static libs (lame) install here
trap 'rm -rf "$WORK"' EXIT

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "error: build must run on Apple Silicon (arm64), got $(uname -m)" >&2
  exit 1
fi

echo "==> Building static LAME $LAME_VERSION"
curl -fsSL -o "$WORK/lame.tar.gz" "$LAME_URL"
shasum -a 256 -c <(grep "lame-${LAME_VERSION}.tar.gz" "$CHECKSUMS" | sed "s#lame-${LAME_VERSION}.tar.gz#$WORK/lame.tar.gz#")
tar -xzf "$WORK/lame.tar.gz" -C "$WORK"
pushd "$WORK/lame-${LAME_VERSION}" >/dev/null
./configure --prefix="$PREFIX" --disable-shared --enable-static \
  --disable-frontend --disable-decoder --host=aarch64-apple-darwin
make -j"$(sysctl -n hw.ncpu)"
make install
popd >/dev/null

echo "==> Cloning FFmpeg $FFMPEG_TAG"
git clone --depth 1 --branch "$FFMPEG_TAG" "$FFMPEG_GIT" "$WORK/ffmpeg"
pushd "$WORK/ffmpeg" >/dev/null

# Audio-only, statically linked, system libraries only. Start from nothing and
# enable exactly the containers/codecs the app reads (input) and writes (output:
# AIFF/WAV PCM, FLAC, ALAC, AAC, MP3 — see src-tauri/src/audio/convert.rs).
echo "==> Configuring minimal FFmpeg"
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure \
  --prefix="$WORK/ffmpeg-out" \
  --pkg-config-flags="--static" \
  --extra-cflags="-I$PREFIX/include" \
  --extra-ldflags="-L$PREFIX/lib" \
  --disable-everything \
  --disable-doc --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
  --disable-ffplay --disable-network --disable-autodetect --disable-debug \
  --enable-small \
  --enable-programs --enable-ffmpeg --enable-ffprobe \
  --enable-swresample \
  --enable-libmp3lame \
  --enable-protocol=file,pipe \
  --enable-demuxer=mp3,flac,mov,wav,aiff,w64,ogg,matroska,aac,ac3,wv,ape,asf \
  --enable-muxer=mp3,flac,ipod,mov,mp4,wav,aiff \
  --enable-decoder=mp3,mp3float,flac,alac,aac,aac_latm,vorbis,opus,ac3,eac3,wavpack,monkeysaudio,wmav1,wmav2,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le,pcm_s16be,pcm_s24be,pcm_u8 \
  --enable-encoder=flac,alac,aac,libmp3lame,pcm_s16le,pcm_s24le,pcm_s16be,pcm_s24be \
  --enable-parser=mpegaudio,flac,aac,aac_latm,vorbis,opus,ac3 \
  --enable-filter=aresample,aformat,anull,pan,channelmap \
  --enable-bsf=aac_adtstoasc

make -j"$(sysctl -n hw.ncpu)"
make install
popd >/dev/null

echo "==> Installing sidecars into $OUT_DIR"
for bin in ffmpeg ffprobe; do
  dst="$OUT_DIR/${bin}-${TARGET}"
  install -m 0755 "$WORK/ffmpeg-out/bin/$bin" "$dst"
  strip -S "$dst" 2>/dev/null || true
  codesign --force --sign - "$dst"        # ad-hoc: required to run on other arm64 Macs
  chmod 0555 "$dst"

  # Self-containment gate: must depend on system libraries only.
  bad="$(otool -L "$dst" | tail -n +2 | awk '{print $1}' \
          | grep -vE '^/usr/lib/|^/System/' || true)"
  if [[ -n "$bad" ]]; then
    echo "error: $bin links against non-system libraries:" >&2
    echo "$bad" >&2
    exit 1
  fi
  echo "    $(basename "$dst"): $(du -h "$dst" | cut -f1), system-only ✓"
done

echo
echo "Done. Now verify format coverage by importing a file of every supported"
echo "type (mp3/flac/alac/aac/wav/aiff/…) before committing the new binaries,"
echo "then run: cd src-tauri && cargo test sidecars_are_self_contained"
