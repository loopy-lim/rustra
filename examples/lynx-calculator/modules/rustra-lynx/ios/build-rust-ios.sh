#!/bin/sh
# Lynx 용 Rust iOS static library 크로스컴파일.
# examples/react-native-calculator/modules/rustra-jsi/ios/build-rust-ios.sh 와 동일 패턴.
set -eu

MODULE_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$MODULE_DIR/../../../.." && pwd)
TARGET=${RUSTRA_IOS_TARGET:-aarch64-apple-ios-sim}
CARGO_BIN=${CARGO_BIN:-"$HOME/.cargo/bin/cargo"}
RUSTUP_BIN=${RUSTUP_BIN:-"$(dirname "$CARGO_BIN")/rustup"}
RUST_HOME=$(cd "$(dirname "$RUSTUP_BIN")/../.." && pwd)
export CARGO_HOME=${CARGO_HOME:-"$RUST_HOME/.cargo"}
export RUSTUP_HOME=${RUSTUP_HOME:-"$RUST_HOME/.rustup"}
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-stable-aarch64-apple-darwin}
export RUSTC=${RUSTC:-"$("$RUSTUP_BIN" which rustc)"}

# RUSTRA_PROFILE=release (default, frozen) | debug (debug_assertions ON → mutable registry)
PROFILE=${RUSTRA_PROFILE:-release}
if [ "$PROFILE" = "release" ]; then
  REL_FLAG="--release"
else
  REL_FLAG=""
fi

"$CARGO_BIN" build \
  --manifest-path "$REPO_ROOT/Cargo.toml" \
  -p rustra-calculator-example \
  --lib \
  $REL_FLAG \
  --target "$TARGET"

mkdir -p "$MODULE_DIR/ios/rust/lib"
cp "$REPO_ROOT/target/$TARGET/$PROFILE/librustra_calculator_example.a" \
  "$MODULE_DIR/ios/rust/lib/librustra_calculator_example.a"
