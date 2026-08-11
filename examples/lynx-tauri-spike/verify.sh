#!/usr/bin/env bash
# 스파이크 성공 기준 1/2/3 자동 검증.
# build-lynx-host.sh 로 .app 을 빌드하고 백그라운드 실행한 뒤 stderr 로그에서
# 결정적 증거를 grep 한다. 디스플레이 캡처 권한(백그라운드 세션)에 의존하지
# 않도록 시각 증거 대신 on_first_screen/CSS 파싱/ackResult 로그를 사용한다.
#
#   성공 기준 1 — Tauri desktop window 오픈      : NSView … SetParent + init rc=0
#   성공 기준 2 — ReactLynx 뷰 렌더링            : on_first_screen + on_load_success
#                                                  (CSS 130300 경고 = 뷰 트리 평가됨)
#   성공 기준 3 — addNumbers rkyv 왕복 결과 42   : invokeRkyvV2 ok=1 + ackResult val=42
#                                                  + SUMMARY resultAcked=1 val=42
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SDK="${LYNX_SDK:-/tmp/lynx-prebuilt/macsdk}"
LOG=/tmp/rustra-spike-verify.log
BIN="$HERE/SpikeApp.app/Contents/MacOS/rustra-lynx-tauri-spike"

echo "[verify] 1/4 ReactLynx bundle"
( cd "$HERE" && npm run build >/dev/null )

echo "[verify] 2/4 host build (.app assemble)"
PROFILE=release "$HERE/build-lynx-host.sh" >/dev/null

echo "[verify] 3/4 run .app (~10s, capture stderr)"
# 이전 실행 잔류 방지
pkill -f rustra-lynx-tauri-spike 2>/dev/null || true
: > "$LOG"
LYNX_SDK="$SDK" \
LYNX_BUNDLE="$HERE/dist/index.lynx.bundle" \
LYNX_ICU="$SDK/data/icudtl.dat" \
  "$BIN" >>"$LOG" 2>&1 &
APP_PID=$!

# SUMMARY 가 first_screen 후 ~120 pump 틱 안에 찍힌다. 여유를 두고 대기.
for _ in $(seq 1 50); do
  sleep 0.2
  grep -q "SUMMARY" "$LOG" && break
done
# SUMMARY 1회 이상 추가 캡처 대기
sleep 1
kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true

echo "[verify] 4/4 check success criteria"
pass=1
check() {  # check <label> <pattern>
  if grep -Eq "$2" "$LOG"; then
    echo "  [PASS] $1"
  else
    echo "  [FAIL] $1  (pat: $2)"
    pass=0
  fi
}
check "1: window open (NSView SetParent + init rc=0)" \
  'NSView = 0x[0-9a-f]+ .* Lynx SetParent'
check "1: window open (lynx_spike_init rc=0)" 'lynx_spike_init rc=0'
check "2: ReactLynx render (on_first_screen)" 'on_first_screen'
check "2: ReactLynx render (on_load_success)" 'on_load_success'
check "3: rkyv invoke ok" 'invokeRkyvV2: in=[0-9]+ out=[0-9]+ ok=1'
check "3: rkyv result acked 42" 'ackResult val=42'
check "3: SUMMARY resultAcked=1 val=42" 'SUMMARY .* resultAcked=1 val=42'

echo
if [[ $pass -eq 1 ]]; then
  echo "[verify] PASS: 성공 기준 1/2/3 모두 충족"
  exit 0
else
  echo "[verify] FAIL: 일부 기준 미충족 — $LOG 참고"
  exit 1
fi
