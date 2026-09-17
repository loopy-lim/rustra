#!/usr/bin/env bash
# Actual production binder/codec on the installed iOS Simulator Hermes runtime.
set -euo pipefail
IOS_DIR="$(cd "$(dirname "$0")" && pwd)"
MODULE_DIR="$(cd "$IOS_DIR/.." && pwd)"
APP_DIR="$(cd "$MODULE_DIR/../.." && pwd)"
WORKTREE="$(cd "$APP_DIR/../.." && pwd)"
PODS="$APP_DIR/ios/Pods"
RN="$APP_DIR/node_modules/react-native"
HERMES="$PODS/hermes-engine/destroot"
HSLICE="$HERMES/Library/Frameworks/universal/hermes.xcframework/ios-arm64_x86_64-simulator"
DSLICE="$PODS/ReactNativeDependencies/framework/packages/react-native/ReactNativeDependencies.xcframework/ios-arm64_x86_64-simulator"
BUILD_DIR="${RUSTRA_NATIVE_TEST_DIR:-/private/tmp/rustra-native-sync-hermes}"
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
mkdir -p "$BUILD_DIR"
xcrun --sdk iphonesimulator clang++ -std=c++20 -O1 -g -fexceptions -frtti \
  -target arm64-apple-ios15.1-simulator -isysroot "$SDK" \
  -I"$RN/ReactCommon/jsi" -I"$RN/ReactCommon/callinvoker" \
  -I"$HERMES/include" -I"$PODS/ReactNativeDependencies/Headers" \
  -I"$WORKTREE/packages/react-native/native/cpp" -I"$MODULE_DIR/generated" \
  "$IOS_DIR/test-rustra-native-sync.cpp" "$MODULE_DIR/generated/rustra-generated-codecs.cpp" \
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
  "$WORKTREE/packages/react-native/native/cpp/rustra-sync-core.hpp" \
  "$WORKTREE/packages/react-native/native/cpp/rustra-sync-contract.hpp" \
  "$HSLICE/hermes.framework/hermes" \
  "$DSLICE/ReactNativeDependencies.framework/ReactNativeDependencies" > "$BUILD_DIR/identities.txt"
if [[ "${RUSTRA_NATIVE_TEST_BUILD_ONLY:-0}" != 1 ]]; then
  : "${RUSTRA_SIMULATOR_UDID:?Set the existing Simulator UDID; this script never boots or installs.}"
  xcrun simctl spawn "$RUSTRA_SIMULATOR_UDID" "$BUILD_DIR/native-sync-test"
fi
