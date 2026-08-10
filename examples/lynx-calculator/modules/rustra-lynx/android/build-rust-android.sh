#!/bin/sh
# Lynx 용 Rust Android static library 크로스컴파일 (cargo-ndk).
# rustra-bridge 에 기존 Android 레퍼런스가 없어 신규 작성.
#
# 요구: cargo-ndk (`cargo install cargo-ndk`) + 아래 타겟이 rustup 에 설치되어 있어야 함:
#   rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android
set -eu

MODULE_DIR=$(cd "$(dirname "$0")/.." && pwd)
REPO_ROOT=$(cd "$MODULE_DIR/../../../.." && pwd)
CARGO_BIN=${CARGO_BIN:-"$HOME/.cargo/bin/cargo"}

PROFILE=${RUSTRA_PROFILE:-release}
REL_FLAG=""
if [ "$PROFILE" = "release" ]; then
  REL_FLAG="--release"
fi

# JNI 가 링크할 ABI 목록. ANDROID_ABIS 로 오버라이드 가능.
ABIS=${ANDROID_ABIS:-"aarch64-linux-android armv7-linux-androideabi x86_64-linux-android"}

mkdir -p "$MODULE_DIR/android/rust/lib"

for ABI in $ABIS; do
  echo "==> building $ABI"
  "$CARGO_BIN" ndk \
    --manifest-path "$REPO_ROOT/Cargo.toml" \
    -t "$ABI" \
    -- $CARGO_BIN build -p rustra-calculator-example --lib $REL_FLAG

  # cargo-ndk 는 target/<abi>/<profile>/librustra_calculator_example.a 로 출력.
  cp "$REPO_ROOT/target/$ABI/$PROFILE/librustra_calculator_example.a" \
     "$MODULE_DIR/android/rust/lib/librustra_calculator_example-$ABI.a"
done
