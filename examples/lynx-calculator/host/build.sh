#!/usr/bin/env bash
# Build the rustra × Lynx macOS host (headless software renderer → RGBA).
# Produces HostApp.app, which is REQUIRED for libLynx to find LynxResources.bundle
# via -[NSBundle mainBundle] at runtime.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
SDK="${LYNX_SDK:-/tmp/lynx-prebuilt/macsdk}"
PROFILE="${RUSTRA_PROFILE:-release}"
STATICLIB="$REPO/target/$PROFILE/librustra_calculator_example.a"
APP="$HERE/HostApp.app"

if [[ ! -f "$STATICLIB" ]]; then
  echo "[build] missing $STATICLIB — run: cargo build --release -p rustra-calculator-example" >&2
  exit 1
fi
if [[ ! -d "$SDK/lib" ]]; then
  echo "[build] missing Lynx SDK at $SDK — set LYNX_SDK" >&2
  exit 1
fi

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
# libLynx resolves assets:// via the main bundle, so the resources bundle must
# live inside our .app.
ln -sfn "$SDK/bundles/LynxResources.bundle" "$APP/Contents/Resources/LynxResources.bundle"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"

clang++ -std=c++17 -O1 -DUSE_WEAK_SUFFIX_NAPI \
  -I"$SDK/include" \
  "$HERE/host.cpp" "$HERE/host_ui.mm" "$STATICLIB" \
  -L"$SDK/lib" -lLynx \
  -framework Cocoa -framework Foundation -framework CoreGraphics -framework Metal -framework MetalKit \
  -framework OpenGL -framework QuartzCore -framework IOKit -framework CoreFoundation \
  -framework ImageIO \
  -rpath "$SDK/lib" \
  -o "$APP/Contents/MacOS/host"

echo "[build] OK -> $APP/Contents/MacOS/host"
