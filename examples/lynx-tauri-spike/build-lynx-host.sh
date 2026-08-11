#!/usr/bin/env bash
# Tauri × Lynx 스파이크 빌드 + .app 조립.
# libLynx 가 -[NSBundle mainBundle] 로 LynxResources.bundle 을 찾으므로 일반 바이너리가
# 아닌 .app 번들이어야 한다(host/build.sh 과 동일 이유). release 로 양쪽 빌드.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SDK="${LYNX_SDK:-/tmp/lynx-prebuilt/macsdk}"
APP="$HERE/SpikeApp.app"
PROFILE="${RUSTRA_PROFILE:-release}"
BIN_NAME="rustra-lynx-tauri-spike"

echo "[build] 1/3 rustra-calculator staticlib (release)"
cargo build --release -p rustra-calculator-example

echo "[build] 2/3 spike Tauri crate ($PROFILE)"
( cd "$HERE/src-tauri" && cargo build $( [[ "$PROFILE" == "release" ]] && echo --release ) -p rustra-lynx-tauri-spike )

echo "[build] 3/3 assemble .app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$REPO/target/$PROFILE/$BIN_NAME" "$APP/Contents/MacOS/$BIN_NAME"
ln -sfn "$SDK/bundles/LynxResources.bundle" "$APP/Contents/Resources/LynxResources.bundle"
cp "$HERE/src-tauri/Info.plist" "$APP/Contents/Info.plist"

echo "[build] OK -> $APP/Contents/MacOS/$BIN_NAME"
echo "[run]   LYNX_BUNDLE=$HERE/dist/index.lynx.bundle LYNX_ICU=$SDK/data/icudtl.dat \\"
echo "         $APP/Contents/MacOS/$BIN_NAME"
