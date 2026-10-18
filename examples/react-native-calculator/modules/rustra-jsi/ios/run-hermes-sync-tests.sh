#!/usr/bin/env bash
# Production binder/codec on Hermes: iOS Simulator or a macOS Catalyst process.
# RUSTRA_NATIVE_DEPS_ROOT may point to an extracted ReactNativeDependencies.xcframework.
set -euo pipefail
IOS_DIR="$(cd "$(dirname "$0")" && pwd)"
MODULE_DIR="$(cd "$IOS_DIR/.." && pwd)"
APP_DIR="$(cd "$MODULE_DIR/../.." && pwd)"
WORKTREE="$(cd "$APP_DIR/../.." && pwd)"
PODS="$APP_DIR/ios/Pods"
RN="$APP_DIR/node_modules/react-native"
HERMES="$PODS/hermes-engine/destroot"
BUILD_DIR="${RUSTRA_NATIVE_TEST_DIR:-/private/tmp/rustra-native-sync-hermes}"
PLATFORM="${RUSTRA_NATIVE_TEST_PLATFORM:-ios-simulator}"
DEPS="${RUSTRA_NATIVE_DEPS_ROOT:-$PODS/ReactNativeDependencies/framework/packages/react-native/ReactNativeDependencies.xcframework}"
if [[ -z "${RUSTRA_NATIVE_DEPS_ROOT:-}" && ! -d "$DEPS" ]]; then
  DEPS="$PODS/ReactNativeDependencies/framework/packages/react-native/third-party/ReactNativeDependencies.xcframework"
fi
EXTRA_FLAGS=()
case "$PLATFORM" in
  ios-simulator)
    SLICE=ios-arm64_x86_64-simulator
    SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
    TARGET=arm64-apple-ios15.1-simulator
    ;;
  mac-catalyst)
    SLICE=ios-arm64_x86_64-maccatalyst
    SDK="$(xcrun --sdk macosx --show-sdk-path)"
    TARGET=arm64-apple-ios15.1-macabi
    EXTRA_FLAGS=(-isystem "$SDK/System/iOSSupport/usr/include" -F"$SDK/System/iOSSupport/System/Library/Frameworks")
    ;;
  *) echo "Unsupported RUSTRA_NATIVE_TEST_PLATFORM: $PLATFORM" >&2; exit 2 ;;
esac
SANITIZER="${RUSTRA_NATIVE_TEST_SANITIZER:-none}"
case "$SANITIZER" in
  none) ;;
  address)
    ASAN_RUNTIME="$(xcrun clang++ -print-resource-dir)/lib/darwin"
    EXTRA_FLAGS+=(-fsanitize=address -fno-omit-frame-pointer -Wl,-rpath,"$ASAN_RUNTIME")
    ;;
  *) echo "Unsupported RUSTRA_NATIVE_TEST_SANITIZER: $SANITIZER" >&2; exit 2 ;;
esac
if [[ "${RUSTRA_NATIVE_SYNC_PERF:-0}" == 1 ]]; then
  if [[ "$PLATFORM" != mac-catalyst ]]; then
    echo "RUSTRA_NATIVE_SYNC_PERF supports only the mac-catalyst host process." >&2
    exit 2
  fi
  EXTRA_FLAGS+=(-DRUSTRA_NATIVE_SYNC_PERF=1)
fi
HSLICE="$HERMES/Library/Frameworks/universal/hermes.xcframework/$SLICE"
DSLICE="$DEPS/$SLICE"
if [[ ! -f "$DEPS/Headers/folly/dynamic.h" || ! -f "$DSLICE/ReactNativeDependencies.framework/ReactNativeDependencies" ]]; then
  echo "Missing native test dependencies at $DEPS. Install the example's iOS Pods or set RUSTRA_NATIVE_DEPS_ROOT to a matching ReactNativeDependencies.xcframework (including Headers and $SLICE)." >&2
  exit 2
fi
if [[ ! -f "$HSLICE/hermes.framework/hermes" ]]; then
  echo "Missing Hermes $SLICE at $HSLICE; install the example's iOS Pods first." >&2
  exit 2
fi
mkdir -p "$BUILD_DIR"
# Prove the instrumented runtime actually starts and detects an error before
# spending time on Hermes. A canary failure is a failed environment gate.
run_native() {
  local expect=()
  if [[ "${1:-}" == --expect-asan ]]; then expect=("$1"); shift; fi
  if [[ "$PLATFORM" == mac-catalyst ]]; then
    node "$IOS_DIR/run-native-test.mjs" "${expect[@]}" "$@"
  else
    : "${RUSTRA_SIMULATOR_UDID:?Set the existing Simulator UDID; this script never boots or installs.}"
    export SIMCTL_CHILD_RUSTRA_NATIVE_RUNTIME_CYCLES="${RUSTRA_NATIVE_RUNTIME_CYCLES:-3}"
    node "$IOS_DIR/run-native-test.mjs" "${expect[@]}" xcrun simctl spawn "$RUSTRA_SIMULATOR_UDID" "$@"
  fi
}
if [[ "$SANITIZER" == address && "${RUSTRA_NATIVE_TEST_BUILD_ONLY:-0}" != 1 ]]; then
  cat > "$BUILD_DIR/asan-probe.cpp" <<'CPP'
#include <cstdlib>
__attribute__((noinline)) int read_freed(volatile int* p) { return *p; }
int main(int argc, char**) {
  if (argc == 1) return 0;
  int* p = new int(1);
  delete p;
  return read_freed(p);
}
CPP
  xcrun clang++ -O1 -g -target "$TARGET" -isysroot "$SDK" "${EXTRA_FLAGS[@]}" \
    "$BUILD_DIR/asan-probe.cpp" -o "$BUILD_DIR/asan-probe"
  run_native "$BUILD_DIR/asan-probe"
  run_native --expect-asan "$BUILD_DIR/asan-probe" canary
fi
xcrun clang++ -std=c++20 -O1 -g -fexceptions -frtti \
  -target "$TARGET" -isysroot "$SDK" "${EXTRA_FLAGS[@]}" \
  -I"$RN/ReactCommon/jsi" -I"$RN/ReactCommon/callinvoker" \
  -I"$HERMES/include" -I"$DEPS/Headers" \
  -I"$WORKTREE/packages/react-native/native/cpp" -I"$MODULE_DIR/generated" \
  "$IOS_DIR/test-rustra-native-sync.cpp" "$MODULE_DIR/generated/rustra-generated-codecs.cpp" \
  "$RN/ReactCommon/jsi/jsi/jsi.cpp" \
  -F"$HSLICE" -F"$DSLICE" -framework hermes -framework ReactNativeDependencies \
  -framework Foundation -framework CoreFoundation \
  -Wl,-rpath,"$HSLICE" -Wl,-rpath,"$DSLICE" -o "$BUILD_DIR/native-sync-test"
shasum -a 256 "$BUILD_DIR/native-sync-test" \
  "$WORKTREE/packages/react-native/native/cpp/RustraJSIBridge.cpp" \
  "$WORKTREE/packages/react-native/native/cpp/RustraJSIBridge.hpp" \
  "$WORKTREE/packages/react-native/native/cpp/RustraSyncBinding.inc" \
  "$MODULE_DIR/generated/rustra-generated-codecs.cpp" \
  "$MODULE_DIR/generated/rustra-generated-codecs.hpp" \
  "$IOS_DIR/test-rustra-native-sync.cpp" "$IOS_DIR"/native-sync-*.inc \
  "$IOS_DIR/run-hermes-sync-tests.sh" \
  "$IOS_DIR/run-native-test.mjs" \
  "$RN/ReactCommon/jsi/jsi/jsi.cpp" \
  "$WORKTREE/packages/react-native/native/cpp/rustra-sync-core.hpp" \
  "$WORKTREE/packages/react-native/native/cpp/rustra-sync-contract.hpp" \
  "$HSLICE/hermes.framework/hermes" \
  "$DSLICE/ReactNativeDependencies.framework/ReactNativeDependencies" > "$BUILD_DIR/identities.txt"
if [[ "${RUSTRA_NATIVE_TEST_BUILD_ONLY:-0}" != 1 ]]; then
  run_native "$BUILD_DIR/native-sync-test"
fi
