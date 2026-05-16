#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RUSTRA_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

TARGET="${RUSTRA_IOS_TARGET:-aarch64-apple-ios-sim}"
CRATE_NAME="rustra-calculator-example"
LIB_NAME="librustra_calculator_example.a"

echo "Building $CRATE_NAME for $TARGET..."

RUSTFLAGS="-C target-feature=+simd128" \
  cargo build \
    --manifest-path "$RUSTRA_ROOT/examples/calculator/Cargo.toml" \
    --lib \
    --release \
    --target "$TARGET"

OUT_DIR="$SCRIPT_DIR/rust/lib"
mkdir -p "$OUT_DIR"
cp "$RUSTRA_ROOT/target/$TARGET/release/$LIB_NAME" "$OUT_DIR/"

echo "Copied $LIB_NAME to $OUT_DIR"
