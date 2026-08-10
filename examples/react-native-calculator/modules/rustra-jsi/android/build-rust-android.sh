#!/bin/sh
# Build Rust static library for Android (cargo-ndk)
set -eu

unset ANDROID_HOME || true
export ANDROID_NDK_HOME=${NDK_HOME:-"$HOME/Library/Android/sdk/ndk/27.1.12297006"}
export NDK_HOME="$ANDROID_NDK_HOME"

MODULE_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$MODULE_DIR/../../../.." && pwd)
CARGO_BIN=${CARGO_BIN:-"$HOME/.cargo/bin/cargo"}

PROFILE=${RUSTRA_PROFILE:-release}
REL_FLAG=""
if [ "$PROFILE" = "release" ]; then
  REL_FLAG="--release"
fi

ABIS=${ANDROID_ABIS:-"x86_64-linux-android aarch64-linux-android"}

for TARGET in $ABIS; do
  echo "==> Building Rust Android target: $TARGET"
  "$CARGO_BIN" ndk \
    -t "$TARGET" \
    build -p rustra-calculator-example --lib $REL_FLAG

  # Map Rust target triple to Android ABI folder
  case "$TARGET" in
    "x86_64-linux-android") ABI="x86_64" ;;
    "aarch64-linux-android") ABI="arm64-v8a" ;;
    "armv7-linux-androideabi") ABI="armeabi-v7a" ;;
    "i686-linux-android") ABI="x86" ;;
    *) ABI="$TARGET" ;;
  esac

  OUT_DIR="$MODULE_DIR/android/src/main/cpp/libs/$ABI"
  mkdir -p "$OUT_DIR"
  cp "$REPO_ROOT/target/$TARGET/$PROFILE/librustra_calculator_example.a" \
     "$OUT_DIR/librustra_calculator_example.a"
done

echo "==> Rust Android static libraries built successfully!"
