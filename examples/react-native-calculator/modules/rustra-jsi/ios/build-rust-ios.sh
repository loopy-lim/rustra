#!/bin/sh
set -eu

MODULE_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$MODULE_DIR/../../../.." && pwd)
TARGET=${RUSTRA_IOS_TARGET:-aarch64-apple-ios-sim}
CARGO_BIN=${CARGO_BIN:-"$HOME/.cargo/bin/cargo"}
RUSTUP_BIN=${RUSTUP_BIN:-"$(dirname "$CARGO_BIN")/rustup"}
RUST_HOME=$(cd "$(dirname "$RUSTUP_BIN")/../.." && pwd)
export CARGO_HOME=${CARGO_HOME:-"$RUST_HOME/.cargo"}
export RUSTUP_HOME=${RUSTUP_HOME:-"$RUST_HOME/.rustup"}
# Respect the toolchain selected by rustup, CI, or the caller. Forcing `stable`
# here makes `cargo` ignore targets installed on a pinned CI toolchain.
export RUSTC=${RUSTC:-"$("$RUSTUP_BIN" which rustc)"}

# RUSTRA_PROFILE=release (default, frozen) | debug (debug_assertions ON → mutable registry)
PROFILE=${RUSTRA_PROFILE:-release}
if [ "$PROFILE" = "release" ]; then
  REL_FLAG="--release"
else
  REL_FLAG=""
fi

mkdir -p "$MODULE_DIR/ios/rust/lib"

build_target() {
  target="$1"
  "$CARGO_BIN" build \
    --manifest-path "$REPO_ROOT/Cargo.toml" \
    -p rustra-calculator-example \
    --lib \
    $REL_FLAG \
    --target "$target"
}

if [ -n "${RUSTRA_IOS_TARGET+set}" ]; then
  # A caller may request a device or a single simulator architecture.
  build_target "$TARGET"
  cp "$REPO_ROOT/target/$TARGET/$PROFILE/librustra_calculator_example.a" \
    "$MODULE_DIR/ios/rust/lib/librustra_calculator_example.a"
else
  # Xcode Release simulator builds ARCHS=arm64 x86_64 by default. Produce a
  # universal simulator archive so Intel and Apple Silicon simulator links
  # both work; device builds remain explicitly selectable above.
  build_target aarch64-apple-ios-sim
  build_target x86_64-apple-ios
  lipo -create \
    "$REPO_ROOT/target/aarch64-apple-ios-sim/$PROFILE/librustra_calculator_example.a" \
    "$REPO_ROOT/target/x86_64-apple-ios/$PROFILE/librustra_calculator_example.a" \
    -output "$MODULE_DIR/ios/rust/lib/librustra_calculator_example.a"
fi
