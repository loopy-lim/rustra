#!/usr/bin/env bash
# rustra runner 템플릿 — desktop 호스트 빌드 + TemplateApp.app 조립.
# 스파이크 examples/lynx-tauri-spike/build-lynx-host.sh 에서 정제 추출.
#
# libLynx 가 -[NSBundle mainBundle] 로 LynxResources.bundle 을 찾으므로 일반 바이너리가
# 아닌 .app 번들이어야 한다. (1) backend staticlib → (2) src-tauri 빌드 → (3) .app 조립.
#
# ▶ create-runner.sh 가 rustra-template-desktop / rustra_template_backend 를 치환한다.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE_ROOT="$(cd "$HERE/.." && pwd)"
SDK="${LYNX_SDK:-/tmp/lynx-prebuilt/macsdk}"
APP="$HERE/TemplateApp.app"
PROFILE="${RUSTRA_PROFILE:-release}"
BIN_NAME="rustra-template-desktop"

echo "[build] 1/3 rustra backend staticlib ($PROFILE)"
cargo build --release --manifest-path "$TEMPLATE_ROOT/backend/Cargo.toml"

echo "[build] 2/3 template desktop crate ($PROFILE)"
( cd "$HERE/src-tauri" && LYNX_SDK="$SDK" cargo build $( [[ "$PROFILE" == "release" ]] && echo --release ) )

echo "[build] 3/3 assemble .app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$HERE/src-tauri/target/$PROFILE/$BIN_NAME" "$APP/Contents/MacOS/$BIN_NAME"
ln -sfn "$SDK/bundles/LynxResources.bundle" "$APP/Contents/Resources/LynxResources.bundle"
cp "$HERE/src-tauri/Info.plist" "$APP/Contents/Info.plist"

echo "[build] OK -> $APP/Contents/MacOS/$BIN_NAME"
echo "[run]   LYNX_BUNDLE=$TEMPLATE_ROOT/app/dist/index.lynx.bundle LYNX_ICU=$SDK/data/icudtl.dat \\"
echo "         $APP/Contents/MacOS/$BIN_NAME"
