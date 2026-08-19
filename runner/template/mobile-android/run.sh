#!/usr/bin/env bash
# Android 실행 게이트 — 스파이크 verify-android.sh 절차를 템플릿 경로로 정제 이식.
#
# 단일 ReactLynx 번들 + 단일 Rust rkyv 백엔드(jni staticlib) 가 Android 에뮬레이터에서
# Lynx SDK 4.0.1 로 렌더링 + greet rkyv 왕복(결과 "Hello, rustra!") 을 증명한다.
#
# ⚠️ 전제: Android SDK(+NDK 27.1 핀) + cargo-ndk + rustup android targets + AVD($AVD).
#
# 결정적 logcat 증거([template-android] TAG):
#   1. renderTemplateUrl             — ReactLynx 번들 로드 요청
#   2. rkyv in bytes=N               — greet 요청 (cmd_id + postcard {name})
#   3. rkyv out bytes=M              — greet 응답
#   4. "Rustra not configured" 없음  — NativeModules.RustraModule 등록 성공
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_ROOT="$(cd "$HERE/.." && pwd)"
ANDROID_DIR="$HERE"
APP_ID="com.rustra.template"
ACTIVITY="$APP_ID/.MainActivity"
APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
SHOT="${SHOT:-/tmp/rustra-template-android-result.png}"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$SDK/platform-tools/adb"
EMU="$SDK/emulator/emulator"
AVD="${AVD:-Medium_Phone_API_36.1}"
ANDROID_SERIAL="${ANDROID_SERIAL:-}"
# NDK 디렉토리(SDK 루트가 아닌 ndk 번들). 환경 ANDROID_NDK_HOME 이 SDK 루트를
# 가리키는 기계도 있으므로, $SDK/ndk/<ver> 를 결정론적으로 고른다. (P6 핀)
NDK_VERSION="${NDK_VERSION:-27.1.12297006}"
NDK_HOME="$SDK/ndk/$NDK_VERSION"

export JAVA_HOME="${JAVA_HOME:-$HOME/.sdkman/candidates/java/current}"
export ANDROID_NDK_HOME="$NDK_HOME"

if [[ ! -x "$ADB" ]]; then
  echo "ERROR: adb not found: $ADB" >&2
  exit 1
fi

if [[ ! -x "$EMU" ]]; then
  echo "ERROR: Android emulator not found: $EMU" >&2
  exit 1
fi

run_adb() {
  if [[ -n "$ANDROID_SERIAL" ]]; then
    "$ADB" -s "$ANDROID_SERIAL" "$@"
  else
    "$ADB" "$@"
  fi
}

echo "==> bundle (rspeedy)"
( cd "$APP_ROOT/app" && npm run build )
cp "$APP_ROOT/app/dist/index.lynx.bundle" \
   "$ANDROID_DIR/app/src/main/assets/main.lynx.bundle"
cp "$APP_ROOT/app/config.json" \
   "$ANDROID_DIR/app/src/main/assets/config.json"

echo "==> rust staticlib (aarch64-linux-android)"
( ANDROID_NDK_HOME="$NDK_HOME" ANDROID_ABIS="aarch64-linux-android" \
    sh "$HERE/modules/rustra-lynx/build-rust-android.sh" )

echo "==> gradle assembleDebug"
( cd "$ANDROID_DIR" && ./gradlew :app:assembleDebug )

# ── 에뮬레이터 부트 보장 ──────────────────────────────
mapfile -t connected_devices < <("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1 }')
if [[ -n "$ANDROID_SERIAL" ]]; then
  if ! printf '%s\n' "${connected_devices[@]}" | grep -Fxq "$ANDROID_SERIAL"; then
    echo "ERROR: ANDROID_SERIAL=$ANDROID_SERIAL is not connected." >&2
    exit 1
  fi
elif [[ "${#connected_devices[@]}" -eq 0 ]]; then
  echo "==> boot emulator $AVD"
  "$EMU" -avd "$AVD" -netdelay none -netspeed full -no-snapshot-load >/tmp/rustra-template-emu.log 2>&1 &
  EMU_PID=$!
  "$ADB" wait-for-device
  echo "    waiting for sys.boot_completed"
  for i in $(seq 1 120); do
    if [ "$(run_adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; then
      echo "    booted at poll $i"; break
    fi
    sleep 2
  done
  mapfile -t connected_devices < <("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1 }')
  if [[ "${#connected_devices[@]}" -ne 1 ]]; then
    echo "ERROR: expected one booted emulator after launch, found ${#connected_devices[@]}." >&2
    echo "       set ANDROID_SERIAL explicitly if another device is connected." >&2
    exit 1
  fi
  ANDROID_SERIAL="${connected_devices[0]}"
elif [[ "${#connected_devices[@]}" -eq 1 ]]; then
  ANDROID_SERIAL="${connected_devices[0]}"
else
  echo "ERROR: multiple Android devices are connected: ${connected_devices[*]}" >&2
  echo "       rerun with ANDROID_SERIAL=<device-serial>." >&2
  exit 1
fi
echo "==> device: $ANDROID_SERIAL"

echo "==> install + launch"
run_adb uninstall "$APP_ID" >/dev/null 2>&1 || true
run_adb install -r "$APK" >/dev/null 2>&1
run_adb logcat -c 2>/dev/null || true
run_adb shell am start -n "$ACTIVITY" >/dev/null 2>&1

# ── rkyv 왕복이 logcat 에 나타날 때까지 폴링 ──────────
echo "==> poll logcat for rkyv roundtrip"
for i in $(seq 1 60); do
  if run_adb logcat -d 2>/dev/null | grep -q "rkyv out"; then
    echo "    rkyv roundtrip at poll $i"; break
  fi
  sleep 1
done

# ── 스크린샷 ──────────────────────────────────────────
run_adb exec-out screencap -p > "$SHOT" 2>/dev/null && echo "==> screenshot: $SHOT"

# ── 결정적 게이트 — logcat grep ───────────────────────
LOGS="$(run_adb logcat -d 2>/dev/null)"
pass=1
check() {
  # Use a here-string instead of echo|grep: with a large logcat dump and
  # pipefail, grep -q can close early and make echo report SIGPIPE.
  if grep -qE "$2" <<< "$LOGS"; then
    echo "  [PASS] $1"
  else
    echo "  [FAIL] $1  (pat: $2)"; pass=0
  fi
}
check "1: renderTemplateUrl (bundle load)" 'template-android: renderTemplateUrl'
check "2: rkyv in  (greet req)"            'template-android: rkyv in bytes=[1-9]'
check "3: rkyv out (greet res)"            'template-android: rkyv out bytes=[1-9]'
check "4: MobileBridge registered"        'template-android: MobileBridge registered'
check "5: FileCap roundtrip"              'template-android: bridge read_file\(config\.json\): [1-9][0-9]* bytes \(assets\)'

if grep -q "Rustra not configured" <<< "$LOGS"; then
  echo "  [FAIL] 6: must NOT have 'Rustra not configured'"; pass=0
else
  echo "  [PASS] 6: no 'Rustra not configured' error"
fi
if grep -qE 'INTERNAL_RUNTIME_ERROR| LynxError ' <<< "$LOGS"; then
  echo "  [FAIL] 7: Lynx runtime error line present"; pass=0
else
  echo "  [PASS] 7: no Lynx runtime error"
fi
if grep -qE 'JNI DETECTED ERROR|FATAL EXCEPTION|Fatal signal' <<< "$LOGS"; then
  echo "  [FAIL] 8: Android native crash/error line present"; pass=0
else
  echo "  [PASS] 8: no Android native crash/error"
fi

echo ""
if [[ $pass -eq 1 ]]; then
  echo "RESULT: Android PASS — ReactLynx <-> Rust rkyv roundtrip (greet) on Android Emulator"
  exit 0
else
  echo "RESULT: Android FAIL — 로그: $ADB -s $ANDROID_SERIAL logcat -d"
  exit 1
fi
