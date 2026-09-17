#!/usr/bin/env bash
set -euo pipefail
TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rustra-receipt-writer.XXXXXX")"
trap 'rm -rf "$TEST_BUILD_DIR"' EXIT
swiftc "$TEST_DIR/../ios/BenchmarkReceiptWriter.swift" \
  "$TEST_DIR/benchmark-receipt-writer.swift" -o "$TEST_BUILD_DIR/receipt-writer"
"$TEST_BUILD_DIR/receipt-writer"
