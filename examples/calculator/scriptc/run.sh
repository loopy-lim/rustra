#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
cargo build --release -p rustra-calculator-example --lib
mkdir -p examples/calculator/scriptc/build
fnm exec --using 26 -- scriptc build examples/calculator/apps/scriptc-app.ts \
  --ffi examples/calculator/scriptc/ffi.json \
  -o examples/calculator/scriptc/build/calculator-scriptc
output="$(examples/calculator/scriptc/build/calculator-scriptc)"
printf '%s\n' "$output"
grep -F 'scriptc FFI zero-config result: 42' <<<"$output"
