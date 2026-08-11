#!/usr/bin/env bash
# Android 실행 게이트 — 스파이크 verify-android.sh 패턴 재사용.
#
# 단일 ReactLynx 번들 + 단일 Rust rkyv 백엔드(jni staticlib 4아키텍처) 가 Android
# 에뮬레이터에서 Lynx SDK 4.0.1 로 렌더링 + greet rkyv 왕복(결과 "Hello, rustra!") 을 증명한다.
#
# ⚠️ 전제:
#   1. Android Studio + NDK(rustup target: aarch64/armv7/x86_64/i686) + Android Lynx SDK 4.0.1.
#   2. Android 셸(modules/rustra-lynx/ + app/) 이 스파이크에서 추출되어 있어야 함 —
#      소스: examples/lynx-calculator/{android, modules/rustra-lynx/android/}
#      (RustraModule.kt nativeInvokeRkyvV2(ByteArray) + JNI_OnLoad init +
#       RustraApplication LynxEnv init + build-rust-android.sh).
#      상세: docs/plans/2026-08-11-lynx-mobile-spike-result.md (3대 갭 해결)
#   3. codegen 으로 app/generated/ 가 이미 생성되어 있어야 함.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$HERE/.." && pwd)"
LOG=/tmp/rustra-template-android.log
PKG="com.rustra.template"  # ▶ create-runner.sh 가 애플리케이션 ID 로 치환.

echo "[android] 1/4 ReactLynx bundle"
( cd "$APP_ROOT/app" && npm run build >/dev/null )

echo "[android] 2/4 Rust jni libs (4 arch)"
# ▶ build-rust-android.sh 를 스파이크(examples/lynx-calculator/modules/rustra-lynx/android/build-rust-android.sh) 에서 추출.
"$HERE/modules/rustra-lynx/build-rust-android.sh" >/dev/null

echo "[android] 3/4 gradle install + run on emulator (~25s, capture logcat)"
: > "$LOG"
( cd "$HERE/app" && ./gradlew installDebug >>"$LOG" 2>&1 ) || true
adb shell am start -n "$PKG/.MainActivity" >/dev/null 2>&1 || true
sleep 8
adb logcat -d -s Lynx:V Rustra:V RustRkyv:V >>"$LOG" 2>&1 || true

echo "[android] 4/4 check success criteria"
pass=1
check() { if grep -Eq "$2" "$LOG"; then echo "  [PASS] $1"; else echo "  [FAIL] $1  (pat: $2)"; pass=0; fi; }

# 게이트 — 스파이크 7패턴 중 Android 결정적 증거.
check "1: LynxEnv init (JNI_OnLoad → rustra init)" 'JNI_OnLoad|rustra.*init'
check "2: ReactLynx render (first_screen)" 'first_screen|onFirstScreen'
check "3: rkyv invoke roundtrip" 'invokeRkyvV2.*ok|result.*Hello'

echo ""
if [[ $pass -eq 1 ]]; then
  echo "RESULT: Android PASS — ReactLynx <-> Rust rkyv roundtrip (greet) on Android Emulator"
  exit 0
else
  echo "RESULT: Android FAIL — 로그: $LOG"
  exit 1
fi
