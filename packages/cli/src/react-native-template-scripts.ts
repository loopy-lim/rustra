function shellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function renderIosBuild(options: {
  manifestFromModule: string;
  rustPackage: string;
  rustLibrary: string;
}): string {
  return `#!/bin/sh
set -eu

MODULE_DIR=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST_PATH="$MODULE_DIR/${options.manifestFromModule}"
PACKAGE=${shellSingleQuoted(options.rustPackage)}
LIBRARY=${shellSingleQuoted(options.rustLibrary)}
TARGET_DIR="$MODULE_DIR/build/target"
CARGO_BIN=\${CARGO_BIN:-cargo}
PROFILE=\${RUSTRA_PROFILE:-release}
REL_FLAG=""
if [ "$PROFILE" = "release" ]; then REL_FLAG="--release"; fi
mkdir -p "$MODULE_DIR/ios/rust/lib"

build_target() {
  "$CARGO_BIN" build --manifest-path "$MANIFEST_PATH" -p "$PACKAGE" --lib \\
    $REL_FLAG --target-dir "$TARGET_DIR" --target "$1"
}

if [ -n "\${RUSTRA_IOS_TARGET:-}" ]; then
  build_target "$RUSTRA_IOS_TARGET"
  cp "$TARGET_DIR/$RUSTRA_IOS_TARGET/$PROFILE/lib$LIBRARY.a" \\
    "$MODULE_DIR/ios/rust/lib/lib$LIBRARY.a"
else
  build_target aarch64-apple-ios-sim
  build_target x86_64-apple-ios
  lipo -create \\
    "$TARGET_DIR/aarch64-apple-ios-sim/$PROFILE/lib$LIBRARY.a" \\
    "$TARGET_DIR/x86_64-apple-ios/$PROFILE/lib$LIBRARY.a" \\
    -output "$MODULE_DIR/ios/rust/lib/lib$LIBRARY.a"
fi
`;
}

export function renderAndroidBuild(options: {
  manifestFromModule: string;
  rustPackage: string;
  rustLibrary: string;
}): string {
  return `#!/bin/sh
set -eu

MODULE_DIR=$(cd "$(dirname "$0")/.." && pwd)
MANIFEST_PATH="$MODULE_DIR/${options.manifestFromModule}"
PACKAGE=${shellSingleQuoted(options.rustPackage)}
LIBRARY=${shellSingleQuoted(options.rustLibrary)}
TARGET_DIR="$MODULE_DIR/build/target"
CARGO_BIN=\${CARGO_BIN:-cargo}
PROFILE=\${RUSTRA_PROFILE:-release}
REL_FLAG=""
if [ "$PROFILE" = "release" ]; then REL_FLAG="--release"; fi
ABIS=\${ANDROID_ABIS:-"x86_64-linux-android aarch64-linux-android"}

if [ ! -f "\${ANDROID_NDK_HOME:-}/source.properties" ]; then
  for SDK_ROOT in "\${ANDROID_HOME:-}" "\${ANDROID_SDK_ROOT:-}"; do
    [ -d "$SDK_ROOT/ndk" ] || continue
    for NDK_ROOT in "$SDK_ROOT"/ndk/*; do
      [ -f "$NDK_ROOT/source.properties" ] || continue
      ANDROID_NDK_HOME="$NDK_ROOT"
    done
  done
  export ANDROID_NDK_HOME
fi

for TARGET in $ABIS; do
  "$CARGO_BIN" ndk -t "$TARGET" build --manifest-path "$MANIFEST_PATH" \\
    -p "$PACKAGE" --lib $REL_FLAG --target-dir "$TARGET_DIR"
  case "$TARGET" in
    x86_64-linux-android) ABI=x86_64 ;;
    aarch64-linux-android) ABI=arm64-v8a ;;
    armv7-linux-androideabi) ABI=armeabi-v7a ;;
    i686-linux-android) ABI=x86 ;;
    *) ABI="$TARGET" ;;
  esac
  OUT="$MODULE_DIR/android/src/main/cpp/libs/$ABI"
  mkdir -p "$OUT"
  cp "$TARGET_DIR/$TARGET/$PROFILE/lib$LIBRARY.a" "$OUT/lib$LIBRARY.a"
done
`;
}
