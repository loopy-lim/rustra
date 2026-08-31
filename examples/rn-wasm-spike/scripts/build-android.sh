#!/bin/sh
# Builds the Android staticlibs (native rustra baseline per ABI) and stages
# them into the RN bridge module:
#
#   scripts/build-android.sh
#     -> backend/target/<abi>/release/librustra_wasm_spike_backend.a
#     -> app/modules/RustraWasmSpike/android/src/main/cpp/libs/<abi>/
#
# Requires: NDK 27.1 at ~/Library/Android/sdk/ndk/27.1.12297006 (the
# backend/.cargo/config.toml linkers reference it) and the wasm artifacts
# are NOT touched here (v1/v2 .wasm come from build-backend.sh/build-v2.sh).
set -eu
DIR=$(cd "$(dirname "$0")/.." && pwd)
BACKEND="$DIR/backend"
MODULE="$DIR/app/modules/RustraWasmSpike"

cd "$BACKEND"
for abi in aarch64-linux-android x86_64-linux-android; do
  cargo build --release --target "$abi"
done

# Stage per-ABI staticlibs where CMakeLists.txt imports them
# (src/main/cpp/libs/<ANDROID_ABI>/). gitignored like every other
# native build output — regenerate before the first Gradle build.
for abi in arm64-v8a x86_64; do
  mkdir -p "$MODULE/android/src/main/cpp/libs/$abi"
  case "$abi" in
    arm64-v8a) tgt=aarch64-linux-android ;;
    x86_64) tgt=x86_64-linux-android ;;
  esac
  cp "$BACKEND/target/$tgt/release/librustra_wasm_spike_backend.a" \
    "$MODULE/android/src/main/cpp/libs/$abi/"
done
echo "staged staticlibs:"
ls -la "$MODULE"/android/src/main/cpp/libs/*/
