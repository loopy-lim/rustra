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
# backend와 desktop은 독립 Cargo workspace지만 같은 runner 안에서는 의존성
# 산출물을 공유한다. 생성된 runner도 루트 target 하나만 정리하면 된다.
RUNNER_TARGET_DIR="${CARGO_TARGET_DIR:-$TEMPLATE_ROOT/target}"
export CARGO_TARGET_DIR="$RUNNER_TARGET_DIR"
export RUSTRA_BACKEND_TARGET_DIR="$RUNNER_TARGET_DIR"

if [[ ! -f "$SDK/include/capi/lynx_env_capi.h" ]]; then
  echo "ERROR: Lynx SDK header not found: $SDK/include/capi/lynx_env_capi.h" >&2
  echo "       install lynx_sdk_macos_arm64.zip or set LYNX_SDK to its macsdk directory" >&2
  exit 1
fi

BACKEND_PROFILE_FLAG=()
if [[ "$PROFILE" == "release" ]]; then
  BACKEND_PROFILE_FLAG+=(--release)
fi

echo "[build] 1/3 rustra backend staticlib ($PROFILE)"
cargo build --manifest-path "$TEMPLATE_ROOT/backend/Cargo.toml" "${BACKEND_PROFILE_FLAG[@]}"

echo "[build] 2/3 template desktop crate ($PROFILE)"
( cd "$HERE/src-tauri" && LYNX_SDK="$SDK" cargo build $( [[ "$PROFILE" == "release" ]] && echo --release ) )

echo "[build] 3/3 assemble .app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$RUNNER_TARGET_DIR/$PROFILE/$BIN_NAME" "$APP/Contents/MacOS/$BIN_NAME"
ln -sfn "$SDK/bundles/LynxResources.bundle" "$APP/Contents/Resources/LynxResources.bundle"
cp "$HERE/src-tauri/Info.plist" "$APP/Contents/Info.plist"
# LaunchServices on current macOS requires the legacy bundle type marker for
# hand-assembled .app bundles to be launchable via `open`.
printf 'APPL????' > "$APP/Contents/PkgInfo"

echo "[build] OK -> $APP/Contents/MacOS/$BIN_NAME"
echo "[run]   LYNX_BUNDLE=$TEMPLATE_ROOT/app/dist/index.lynx.bundle LYNX_ICU=$SDK/data/icudtl.dat \\"
echo "         $APP/Contents/MacOS/$BIN_NAME"
