#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
# scriptc 버전 핀 — 단일 출처. CI(ts-runtime)는 같은 리터럴로 전역 설치하며,
# scripts/check-test-list-parity.mjs 가 양쪽 리터럴의 일치를 검증한다.
SCRIPTC_VERSION=0.2.1
cargo build --release -p rustra-calculator-example --lib
mkdir -p examples/calculator/scriptc/build
if command -v scriptc >/dev/null 2>&1; then
  SCRIPTC=(scriptc)
else
  # scriptc 는 Node >=24 런타임을 요구한다(engines). 로컬 기본 PATH 에 없으면
  # fnm 26 을 쓴다 — CI ts-runtime 은 setup-node 26 + 전역 설치로 PATH 를 이미
  # 갖춘 뒤 이 스크립트에 진입한다.
  SCRIPTC=(fnm exec --using 26 -- scriptc)
fi
installed="$("${SCRIPTC[@]}" --version)"
if [[ "$installed" != "$SCRIPTC_VERSION" ]]; then
  echo "FAIL: scriptc@$SCRIPTC_VERSION 필요 — 설치된 버전: ${installed:-없음}" >&2
  echo "  npm install -g scriptc@$SCRIPTC_VERSION   # engines: node >=24" >&2
  exit 2
fi
"${SCRIPTC[@]}" build examples/calculator/apps/scriptc-app.ts \
  --ffi examples/calculator/scriptc/ffi.json \
  -o examples/calculator/scriptc/build/calculator-scriptc
output="$(examples/calculator/scriptc/build/calculator-scriptc)"
printf '%s\n' "$output"
grep -F 'scriptc FFI zero-config result: 42' <<<"$output"
