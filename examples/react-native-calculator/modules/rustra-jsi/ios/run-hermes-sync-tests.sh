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
  "$WORKTREE/packages/react-native/native/cpp/RustraSyncBinding.inc" \
  "$MODULE_DIR/generated/rustra-generated-codecs.cpp" \
  "$MODULE_DIR/generated/rustra-generated-codecs.hpp" \
  "$IOS_DIR/test-rustra-native-sync.cpp" "$IOS_DIR"/native-sync-*.inc \
  "$IOS_DIR/run-hermes-sync-tests.sh" \
  "$RN/ReactCommon/jsi/jsi/jsi.cpp" \
  "$WORKTREE/packages/react-native/native/cpp/rustra-sync-core.hpp" \
  "$WORKTREE/packages/react-native/native/cpp/rustra-sync-contract.hpp" \
  "$HSLICE/hermes.framework/hermes" \
  "$DSLICE/ReactNativeDependencies.framework/ReactNativeDependencies" > "$BUILD_DIR/identities.txt"
if [[ "${RUSTRA_NATIVE_TEST_BUILD_ONLY:-0}" != 1 ]]; then
  if [[ "$PLATFORM" == mac-catalyst ]]; then
    "$BUILD_DIR/native-sync-test"
  else
    : "${RUSTRA_SIMULATOR_UDID:?Set the existing Simulator UDID; this script never boots or installs.}"
    xcrun simctl spawn "$RUSTRA_SIMULATOR_UDID" "$BUILD_DIR/native-sync-test"
  fi
fi
