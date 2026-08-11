#!/usr/bin/env bash
# Desktop(macOS) 실행 게이트 — 스파이크 verify.sh 패턴 재사용.
#
# 단일 ReactLynx 번들 + 단일 Rust rkyv 백엔드가 Tauri window 안에서 Lynx surface
# (SetParent NSView) 로 렌더링 + greet rkyv 왕복(결과 "Hello, rustra!") 을 증명한다.
#
# ⚠️ 전제:
#   1. LYNX_SDK 환경변수 = macOS Lynx SDK 해제 경로(macsdk; libLynx.dylib + include + data).
#      다운로드: gh release download 4.0.1 --repo lynx-family/lynx --pattern lynx_sdk_macos_arm64.zip
#   2. desktop host 셸(src-tauri/) 이 스파이크에서 추출되어 있어야 함 —
#      소스: examples/lynx-tauri-spike/src-tauri/{main.rs, src/lynx_desktop.mm}
#      (template.app → rustra init 명시 호출 + SetParent NSView + FML Mach-O 펌프).
#      상세: docs/plans/2026-08-11-tauri-lynx-desktop-design.md
#   3. Windows 빌드는 verify-windows.ps1 (Windows 머신).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$HERE/.." && pwd)"
SDK="${LYNX_SDK:-/tmp/lynx-prebuilt/macsdk}"
LOG=/tmp/rustra-template-desktop.log
BIN="$HERE/src-tauri/../../TemplateApp.app/Contents/MacOS/rustra-template-desktop"

echo "[desktop] 1/4 ReactLynx bundle"
( cd "$APP_ROOT/app" && npm run build >/dev/null )

echo "[desktop] 2/4 host build (.app assemble)"
# ▶ build-lynx-host.sh 를 스파이크(examples/lynx-tauri-spike/build-lynx-host.sh) 에서 추출.
PROFILE=release "$HERE/build-lynx-host.sh" >/dev/null

echo "[desktop] 3/4 run .app (~10s, capture stderr)"
pkill -f rustra-template-desktop 2>/dev/null || true
: > "$LOG"
LYNX_SDK="$SDK" \
LYNX_BUNDLE="$APP_ROOT/app/dist/index.lynx.bundle" \
LYNX_ICU="$SDK/data/icudtl.dat" \
  "$BIN" >>"$LOG" 2>&1 &
APP_PID=$!
for _ in $(seq 1 50); do
  sleep 0.2
  grep -q "SUMMARY" "$LOG" && break
done
sleep 1
kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true

echo "[desktop] 4/4 check success criteria"
pass=1
check() { if grep -Eq "$2" "$LOG"; then echo "  [PASS] $1"; else echo "  [FAIL] $1  (pat: $2)"; pass=0; fi; }

# 게이트 — 스파이크 7패턴 중 데스크톱 결정적 증거 (greet 왕복).
check "1: window open (native handle SetParent + init rc=0)" \
  'native window handle = 0x[0-9a-f]+ .* Lynx SetParent'
check "1: window open (rustra init rc=0)" 'rc=0'
check "2: ReactLynx render (on_first_screen)" 'on_first_screen'
check "2: ReactLynx render (on_load_success)" 'on_load_success'
check "3: rkyv invoke ok" 'invokeRkyvV2: in=[0-9]+ out=[0-9]+ ok=1'

echo ""
if [[ $pass -eq 1 ]]; then
  echo "RESULT: desktop PASS — ReactLynx <-> Rust rkyv roundtrip (greet) on macOS"
  exit 0
else
  echo "RESULT: desktop FAIL — 로그: $LOG"
  exit 1
fi
