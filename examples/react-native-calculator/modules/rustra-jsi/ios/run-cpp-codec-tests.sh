#!/usr/bin/env bash
# run-cpp-codec-tests.sh — 생성된 C++ codec 단위/교차 테스트를 독립 빌드/실행.
#
# test-jsi-shim.hpp 가 namespace facebook::jsi 를 정의하므로 진짜 React jsi/jsi.h 가
# 필요 없다. <jsi/jsi.h> 인클루드를 빈 stub 으로 치환하고 shim 을 force-include 해서
# rustra-generated-codecs.cpp 를 단독 컴파일한다. (각 테스트 파일이 자신의 main() 을
# 가지므로 별개의 바이너리로 빌드한다.)
#
# Phase 2 Task 2.5: Rust(wire_fixtures.rs) ↔ TS(cross-wire.test.ts) ↔ C++(본 스크립트)
# 세 코너가 동일 fixture hex 를 byte-exact 로 round-trip 함을 증명한다.
set -euo pipefail

IOS_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="${TMPDIR:-/tmp}/rustra-cpp-codec-build"
STUB_DIR="$BUILD_DIR/jsi"
CXX="${CXX:-clang++}"

mkdir -p "$STUB_DIR"
printf '#pragma once\n// stub: facebook::jsi 는 test-jsi-shim.hpp (force-included) 가 제공.\n' \
  > "$STUB_DIR/jsi.h"

COMMON_FLAGS=(-std=c++17 -O2 -Wall -Wextra -DRUSTRA_TEST_JSI_SHIM=1 -I"$IOS_DIR" -I"$BUILD_DIR" -include test-jsi-shim.hpp)
FAIL=0

run_one() {
  local name="$1"; shift
  local binary="$BUILD_DIR/$name"
  echo "→ compiling $name ..."
  "$CXX" "${COMMON_FLAGS[@]}" "$@" -o "$binary"
  echo "→ running $name ..."
  "$binary" || FAIL=$?
}

# (A) 생성된 codec 교차 테스트 — Task 2.5 의 본체. fixture hex 교차 검증 포함.
run_one tgen "$IOS_DIR/test-rustra-generated-codecs.cpp" "$IOS_DIR/rustra-generated-codecs.cpp"

# (B) 저수준 Writer/Reader 단위 테스트 (rustra-codec.hpp, 헤더-only).
run_one tcodec "$IOS_DIR/test-rustra-codec.cpp"

if [ "$FAIL" -ne 0 ]; then
  echo "FAILED: some C++ codec checks failed (exit $FAIL)"
  exit "$FAIL"
fi
echo "OK: all C++ codec tests passed"
