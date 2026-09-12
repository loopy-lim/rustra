#!/usr/bin/env bash
# android-emulator-runner executes each script input line in a separate shell.
# Keep installation, variables, polling and assertions in this one process.
set -euo pipefail

case "${1:-}" in
  rn)
    app_id="com.altshifted.reactnativecalculator"
    apk="examples/react-native-calculator/android/app/build/outputs/apk/release/app-release.apk"
    ok_marker="__RUSTRA_SMOKE_OK__"
    fail_marker="__RUSTRA_SMOKE_FAIL__"
    log_name="rustra-logcat.txt"
    ;;
  uniffi)
    app_id="dev.rustra.uniffi.smoke"
    apk="examples/uniffi-android-smoke/app/build/outputs/apk/debug/app-debug.apk"
    ok_marker="__RUSTRA_UNIFFI_OK__ addNumbers(20,22)=42"
    fail_marker="__RUSTRA_UNIFFI_FAIL__"
    log_name="rustra-uniffi-logcat.txt"
    ;;
  *) echo "usage: $0 rn|uniffi" >&2; exit 2 ;;
esac

log_path="${RUNNER_TEMP:?RUNNER_TEMP must be set}/$log_name"
attempts="${RUSTRA_SMOKE_ATTEMPTS:-60}"
delay="${RUSTRA_SMOKE_DELAY_SECONDS:-5}"
if [[ ! "$attempts" =~ ^[1-9][0-9]*$ || ! "$delay" =~ ^[0-9]+$ ]]; then
  echo "::error::smoke attempts must be positive and delay must be non-negative" >&2
  exit 2
fi

adb install -r "$apk"
adb logcat -c
adb shell monkey -p "$app_id" -c android.intent.category.LAUNCHER 1

found=0
for ((i = 0; i < attempts; i++)); do
  adb logcat -d > "$log_path" || true
  if grep -Fq "$fail_marker" "$log_path"; then
    echo "::error::$fail_marker observed" >&2
    tail -n 200 "$log_path" >&2
    exit 1
  fi
  if grep -Fq "$ok_marker" "$log_path"; then
    found=1
    break
  fi
  sleep "$delay"
done
if [[ "$found" -ne 1 ]]; then
  echo "::error::$ok_marker was not observed" >&2
  tail -n 200 "$log_path" >&2
  exit 1
fi

pid="$(adb shell pidof "$app_id" | tr -d '[:space:]\r')" || pid=""
if [[ -z "$pid" ]]; then
  echo "::error::app process is not alive: $app_id" >&2
  exit 1
fi
echo "smoke OK: pid=$pid, $ok_marker observed"
