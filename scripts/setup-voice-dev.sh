#!/usr/bin/env bash
# Dev-only setup for voice conversation mode (Phase 1, Linux).
# Builds whisper.cpp's whisper-server at a pinned tag and downloads the
# ggml small.en model into resources/voice/. Packaged builds get CI-built
# binaries in Phase 3.
set -euo pipefail

PIN="v1.7.5"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/resources/voice"
BUILD_DIR="${TMPDIR:-/tmp}/otto-whisper-build"

mkdir -p "$OUT/models"

if [ ! -x "$OUT/whisper-server" ]; then
  echo "==> Building whisper-server ($PIN)"
  rm -rf "$BUILD_DIR"
  git clone --depth 1 --branch "$PIN" https://github.com/ggml-org/whisper.cpp "$BUILD_DIR"
  cmake -S "$BUILD_DIR" -B "$BUILD_DIR/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF
  cmake --build "$BUILD_DIR/build" -j "$(nproc)" --target whisper-server
  cp "$BUILD_DIR/build/bin/whisper-server" "$OUT/whisper-server"
  echo "==> whisper-server installed at $OUT/whisper-server"
else
  echo "==> whisper-server already present, skipping build"
fi

MODEL="$OUT/models/ggml-small.en.bin"
if [ ! -f "$MODEL" ]; then
  echo "==> Downloading ggml-small.en.bin (~466 MB)"
  curl -L --fail --progress-bar -o "$MODEL.part" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin"
  mv "$MODEL.part" "$MODEL"
else
  echo "==> whisper model already present, skipping download"
fi

echo "==> Voice dev assets ready."
