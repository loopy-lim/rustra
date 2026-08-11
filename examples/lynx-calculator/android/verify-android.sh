#!/usr/bin/env bash
# rustra-bridge Lynx Android spike — 자동 검증 스크립트.
# 단일 ReactLynx 번들 + 단일 rustra rkyv 백엔드가 Android 에뮬레이터에서
# 실제 Rust FFI 왕복(addNumbers(20,22) → 42) 을 수행하는지 증명한다.
#
# 결정적 logcat 증거(spike-android TAG):
#   1. renderTemplateUrl             — ReactLynx 번들 로드 요청
#   2. rkyv in bytes=4               — addNumbers 요청 (cmd 1 + postcard {a:20,b:22})
#   3. rkyv out bytes=9              — addNumbers→42 응답 ([ok][7B pad][postcard value:42])
#   4. (오류/권한) out bytes 에 52/95 — typed error + capability.denied
#   5. "Rustra not configured" 없음  — NativeModules.RustraModule 등록 성공
#
# iOS verify-ios.sh 와 동일한 게이트 구조(동일 바이트 카운트 → 동일 와이어 포맷).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # examples/lynx-calculator
ANDROID_DIR="$ROOT/android"
APP_ID="com.rustra.lynxapp"
ACTIVITY="$APP_ID/.MainActivity"
APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$SDK/platform-tools/adb"
EMU="$SDK/emulator/emulator"
AVD="${AVD:-Medium_Phone_API_36.1}"
SHOT="${SHOT:-/tmp/lynx-android-result.png}"
# NDK 디렉토리(SDK 루트가 아닌 ndk 번들). 환경 ANDROID_NDK_HOME 이 SDK 루트를
# 가리키는 기계도 있으므로, $SDK/ndk/<ver> 를 결정론적으로 고른다.
NDK_VERSION="${NDK_VERSION:-27.1.12297006}"
NDK_HOME="$SDK/ndk/$NDK_VERSION"

export JAVA_HOME="${JAVA_HOME:-$HOME/.sdkman/candidates/java/current}"
export ANDROID_NDK_HOME="$NDK_HOME"

echo "==> bundle (rspeedy)"
( cd "$ROOT" && npm run build >/dev/null 2>&1 )
cp "$ROOT/dist/index.lynx.bundle" "$ANDROID_DIR/app/src/main/assets/main.lynx.bundle"

echo "==> rust staticlib (aarch64-linux-android)"
( cd "$ROOT" && ANDROID_NDK_HOME="$NDK_HOME" ANDROID_ABIS="aarch64-linux-android" \
    bash modules/rustra-lynx/android/build-rust-android.sh >/dev/null 2>&1 )

echo "==> gradle assembleDebug"
( cd "$ANDROID_DIR" && ./gradlew :app:assembleDebug >/dev/null 2>&1 )

# ── 에뮬레이터 부트 보장 ──────────────────────────────
booted="$("$ADB" devices | grep -v 'List of devices' | grep -c 'device$' || true)"
if [ "$booted" -eq 0 ]; then
  echo "==> boot emulator $AVD"
  "$EMU" -avd "$AVD" -netdelay none -netspeed full -no-snapshot-load >/tmp/emu.log 2>&1 &
  EMU_PID=$!
  "$ADB" wait-for-device
  echo "    waiting for sys.boot_completed"
  for i in $(seq 1 120); do
    if [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      echo "    booted at poll $i"; break
    fi
    sleep 2
  done
else
  echo "==> emulator already running"
fi

echo "==> install + launch"
"$ADB" uninstall "$APP_ID" >/dev/null 2>&1 || true
"$ADB" install -r "$APK" >/dev/null 2>&1
"$ADB" logcat -c 2>/dev/null || true
"$ADB" shell am start -n "$ACTIVITY" >/dev/null 2>&1

# ── rkyv 왕복이 logcat 에 나타날 때까지 폴링 ──────────
echo "==> poll logcat for rkyv roundtrip"
for i in $(seq 1 60); do
  if "$ADB" logcat -d 2>/dev/null | grep -q "rkyv out"; then
    echo "    rkyv roundtrip at poll $i"; break
  fi
  sleep 1
done

# ── 스크린샷 ──────────────────────────────────────────
"$ADB" exec-out screencap -p > "$SHOT" 2>/dev/null && echo "==> screenshot: $SHOT"

# ── 결정적 게이트 — logcat grep ───────────────────────
LOGS="$("$ADB" logcat -d 2>/dev/null)"
pass=0; fail=0
check() {
  local label="$1" pat="$2"
  if echo "$LOGS" | grep -qE "$pat"; then
    echo "  PASS  $label"; pass=$((pass+1))
  else
    echo "  FAIL  $label"; fail=$((fail+1))
  fi
}
check "1. renderTemplateUrl (bundle load)" 'spike-android: renderTemplateUrl'
check "2. rkyv in  (addNumbers req)"       'spike-android: rkyv in bytes=4'
check "3. rkyv out=9 (addNumbers→42)"      'spike-android: rkyv out bytes=9'
check "4. typed error roundtrip (out=52)"  'spike-android: rkyv out bytes=52'
check "5. capability.denied (out=95)"      'spike-android: rkyv out bytes=95'

if echo "$LOGS" | grep -q "Rustra not configured"; then
  echo "  FAIL  6. must NOT have 'Rustra not configured'"; fail=$((fail+1))
else
  echo "  PASS  6. no 'Rustra not configured' error"; pass=$((pass+1))
fi

# Lynx JS 치명 오류 미발생 확인(선택).
if echo "$LOGS" | grep -qE 'INTERNAL_RUNTIME_ERROR| LynxError '; then
  echo "  WARN  7. Lynx runtime error line present (investigate)"; fail=$((fail+1))
else
  echo "  PASS  7. no Lynx runtime error"; pass=$((pass+1))
fi

echo "==> SUMMARY pass=$pass fail=$fail"
if [ "$fail" -eq 0 ]; then
  echo "RESULT: Android spike PASS — ReactLynx↔Rust rkyv roundtrip on Android"; exit 0
else
  echo "RESULT: Android spike FAIL"; exit 1
fi
