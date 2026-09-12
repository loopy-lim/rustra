#!/usr/bin/env bash
set -euo pipefail

# UniFFI iOS 시뮬레이터 런타임 스모크 — 빌드부터 마커 단언까지 한 번에 실행.
#
# 진행 순서:
#   1. Rust staticlib (aarch64-apple-ios-sim) 빌드
#   2. swiftc 로 생성 바인딩 + main.swift 를 시뮬레이터 바이너리로 컴파일
#      (-I 로 modulemap 디렉터리 제공 → canImport(rustra_calculator_exampleFFI))
#   3. 사용 가능한 iPhone 시뮬레이터를 골라 부팅(rn-ios 잡과 동일한 방식)
#   4. `xcrun simctl spawn <sim> <binary>` 로 실행해 stdout 에서 마커 단언
#
# spawn 방식에 대해: staticlib 는 완전 링크된 자체 포함 바이너리를 만들므로
# .app 번들 설치(simctl install/launch)가 필요 없다. simctl spawn 은 임의
# 실행 파일을 시뮬레이터 런타임 환경에서 구동한다(로컬 실측으로 검증 —
# spawn 이 거부하는 런타임이 나오면 그때 .app 포장으로 전환한다).
#
# 실행 위치: repo 루트에서 `bash examples/uniffi-ios-smoke/build-and-run.sh`

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TRIPLE="aarch64-apple-ios-sim"
PROFILE="${PROFILE:-debug}"
BINDING_DIR="$ROOT/examples/calculator/uniffi"
STATICLIB="$ROOT/target/$TRIPLE/$PROFILE/librustra_calculator_example.a"
OUT_DIR="$ROOT/examples/uniffi-ios-smoke/build"
LOG="$OUT_DIR/smoke-stdout.log"

mkdir -p "$OUT_DIR"

# ── 1. Rust staticlib ────────────────────────────────────────────────────────
# 항상 실행한다(증분) — stale .a 로 링크해 checksum mismatch 라는 오해를 만들
# 것을 방지. 코드젠 산출과 .so/.a 의 버전 불일치는 uniffi checksum 이 잡는다.
cargo build -p rustra-calculator-example --features uniffi --target "$TRIPLE"
test -f "$STATICLIB" || {
  echo "::error::staticlib 이 없다: $STATICLIB" >&2
  exit 1
}

# ── 2. swiftc 링크 ───────────────────────────────────────────────────────────
SDK="$(xcrun --sdk iphonesimulator --show-sdk-path)"
BINARY="$OUT_DIR/rustra-uniffi-smoke"
# 생성 .swift 는 canImport(rustra_calculator_exampleFFI) 로 FFI 모듈을 참조한다.
# 주의: 단순 -I 만으로는 <crate>FFI.modulemap 같은 비표준 이름의 모듈맵이
# 임포트 경로에 잡히지 않는다(로컬 실측 — canImport 실패로 FFI 심볼 수백 개
# 컴파일 에러). -Xcc -fmodule-map-file= 로 모듈맵을 직접 등록하고 -I 로 header
# 탐색 경로를 연다. 심볼은 staticlib 에서 정적 링크한다(자체 포함 바이너리 →
# simctl spawn 가능).
swiftc \
  "$BINDING_DIR/rustra_calculator_example.swift" \
  "$ROOT/examples/uniffi-ios-smoke/main.swift" \
  -o "$BINARY" \
  -sdk "$SDK" \
  -target arm64-apple-ios13.0-simulator \
  -I "$BINDING_DIR" \
  -Xcc -fmodule-map-file="$BINDING_DIR/rustra_calculator_exampleFFI.modulemap" \
  -L "$ROOT/target/$TRIPLE/$PROFILE" \
  -lrustra_calculator_example \
  2> "$OUT_DIR/swiftc.log" || {
    echo "::error::swiftc 링크 실패" >&2
    tail -n 50 "$OUT_DIR/swiftc.log" >&2
    exit 1
  }

# ── 3. 시뮬레이터 선택/부팅 (rn-ios 잡의 선택 로직과 동일한 기준) ────────────
SIM_NAME="$(xcrun simctl list devices available | awk -F'(' '/iPhone/ && (/Shutdown/ || /Booted/) { sub(/\(.*/, ""); gsub(/^[ \t]+|[ \t]+$/, ""); print; exit }')"
if [ -z "$SIM_NAME" ]; then
  echo "::error::사용 가능한 iPhone 시뮬레이터가 없다" >&2
  xcrun simctl list devices available >&2
  exit 1
fi
echo "smoke simulator: $SIM_NAME"
xcrun simctl boot "$SIM_NAME" 2>/dev/null || true
xcrun simctl bootstatus "$SIM_NAME" -b

# ── 4. spawn + 마커 단언 ─────────────────────────────────────────────────────
if ! xcrun simctl spawn "$SIM_NAME" "$BINARY" > "$LOG" 2>&1; then
  echo "::error::simctl spawn 실패 ($SIM_NAME)" >&2
  cat "$LOG" >&2 || true
  exit 1
fi

if grep -q '__RUSTRA_UNIFFI_FAIL__' "$LOG"; then
  echo "::error::__RUSTRA_UNIFFI_FAIL__ 마커 관측 — 바인딩 실행 실패" >&2
  cat "$LOG" >&2
  exit 1
fi
if ! grep -q '__RUSTRA_UNIFFI_OK__ addNumbers(20,22)=42' "$LOG"; then
  echo "::error::__RUSTRA_UNIFFI_OK__ 마커를 stdout 에서 관측하지 못했다" >&2
  cat "$LOG" >&2
  exit 1
fi
echo "smoke OK: __RUSTRA_UNIFFI_OK__ 관측 ($SIM_NAME)"
