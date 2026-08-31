#!/bin/sh
# prepare_command for the RustraWasmSpike pod.
#
# CocoaPods only accepts source_files/vendored_libraries INSIDE the pod root,
# but the wasm3 vendor dir and the Rust staticlib live in the spike tree
# (native/wasm3, artifacts/) — outside both consumption locations of this
# module (source tree modules/ and bun's node_modules file:-dep copy).
# So this script stages copies into the pod itself:
#   ios/wasm3/*.c *.h                     <- spike-root/native/wasm3
#   ios/rust/lib/librustra_wasm_spike_backend.a <- built for aarch64-apple-ios-sim
set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
POD_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

SPIKE_ROOT="$POD_ROOT"
while [ "$SPIKE_ROOT" != "/" ] && [ ! -f "$SPIKE_ROOT/backend/Cargo.toml" ]; do
  SPIKE_ROOT=$(dirname "$SPIKE_ROOT")
done
if [ "$SPIKE_ROOT" = "/" ]; then
  echo "build-rust-ios.sh: cannot locate backend/Cargo.toml above $POD_ROOT" >&2
  exit 1
fi

# 1) Stage wasm3 sources into the pod.
mkdir -p "$POD_ROOT/ios/wasm3"
cp "$SPIKE_ROOT"/native/wasm3/*.c "$SPIKE_ROOT"/native/wasm3/*.h "$POD_ROOT/ios/wasm3/"

# 2) Build (or reuse) the simulator staticlib and stage it into the pod.
BACKEND="$SPIKE_ROOT/backend"
ARCHIVE="$BACKEND/target/aarch64-apple-ios-sim/release/librustra_wasm_spike_backend.a"
OUT_DIR="$SPIKE_ROOT/artifacts/ios-sim"

if [ ! -f "$ARCHIVE" ]; then
  (cd "$BACKEND" && cargo build --release --target aarch64-apple-ios-sim)
fi

mkdir -p "$OUT_DIR" "$POD_ROOT/ios/rust/lib"
cp "$ARCHIVE" "$OUT_DIR/librustra_wasm_spike_backend.a"
cp "$ARCHIVE" "$POD_ROOT/ios/rust/lib/librustra_wasm_spike_backend.a"
echo "staged: ios/wasm3 + ios/rust/lib/librustra_wasm_spike_backend.a"
