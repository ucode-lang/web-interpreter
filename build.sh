#!/usr/bin/env bash
# Build ucode as a WebAssembly module for the web interpreter.
#
# Usage:
#   ./build.sh              # build (default)
#   ./build.sh clean        # remove build artifacts
#
# Prerequisites:
#   - emsdk activated (emcc in $PATH)
#   - cmake and git in $PATH (ucode and its json-c/libmd dependencies are
#     fetched and built by CMake, see CMakeLists.txt; network access needed)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD="$ROOT/build"

EMSDK="${EMSDK:-$HOME/tools/emsdk}"
# shellcheck disable=SC1091
[ -f "$EMSDK/emsdk_env.sh" ] && source "$EMSDK/emsdk_env.sh"

if ! command -v emcc &>/dev/null; then
    echo "error: emcc not found. Activate emsdk first:"
    echo "  source $EMSDK/emsdk_env.sh" >&2
    exit 1
fi

if ! command -v cmake &>/dev/null; then
    echo "error: cmake not found (needed to build ucode and its deps)" >&2
    exit 1
fi

if [ "${1:-}" = "clean" ]; then
    rm -rf "$BUILD" "$ROOT/dist"
    echo "cleaned."
    exit 0
fi

cmake -S "$ROOT" -B "$BUILD" \
    -DCMAKE_TOOLCHAIN_FILE="$ROOT/cmake/emscripten.cmake" \
    -DCMAKE_BUILD_TYPE=Release
cmake --build "$BUILD" -j"$(nproc)"

echo "==> done"
echo "    $ROOT/dist/ucode.js  ($(du -h "$ROOT/dist/ucode.js" | cut -f1))"
echo "    $ROOT/dist/ucode.wasm ($(du -h "$ROOT/dist/ucode.wasm" | cut -f1))"
echo "    published to web/ (open web/index.html)"