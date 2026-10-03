#!/usr/bin/env bash
#
# verify-benchmark-claims.sh — consistency gate for docs/marketing/benchmark-highlights.md
#
# Checks, without running any measurement:
#   1. the highlights page exists and contains no placeholders;
#   2. every relative markdown link on the page resolves to an existing file,
#      and section anchors match a real heading in the target document;
#   3. every quoted figure appears verbatim in its source document or raw
#      benchmark receipt (so the page cannot drift from the evidence).
#
# Usage: bash docs/marketing/verify-benchmark-claims.sh   (from anywhere)

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DOC="$SCRIPT_DIR/benchmark-highlights.md"

FAILS=0
OKS=0

fail() { echo "FAIL: $*"; FAILS=$((FAILS + 1)); }
pass() { echo "ok:   $*"; OKS=$((OKS + 1)); }

# ---------------------------------------------------------------- 1. existence
if [[ -s "$DOC" ]]; then
  pass "highlights page exists and is non-empty"
else
  fail "highlights page missing or empty: $DOC"
  echo "1 check failed"
  exit 1
fi

# ------------------------------------------------------------ 2. no placeholders
if grep -qiE 'TODO|TBD|FIXME|placeholder|lorem ipsum' "$DOC"; then
  fail "highlights page contains placeholder markers"
  grep -inE 'TODO|TBD|FIXME|placeholder|lorem ipsum' "$DOC"
else
  pass "no placeholder markers on the page"
fi

# ------------------------------------------- 3. relative links resolve (+ anchors)
while IFS= read -r link; do
  target="${link%%#*}"
  anchor=""
  case "$link" in
    *"#"*) anchor="${link#*#}" ;;
  esac
  case "$target" in
    http://*|https://*|mailto:*) continue ;;
  esac
  resolved="$SCRIPT_DIR/$target"
  if [[ -e "$resolved" ]]; then
    pass "link target exists: $target"
  else
    fail "broken link: $target"
    continue
  fi
  if [[ -n "$anchor" && -f "$resolved" ]]; then
    slugs="$(grep -E '^#{1,6} ' "$resolved" |
      sed -e 's/^#* //' -e 's/`//g' |
      tr '[:upper:]' '[:lower:]' |
      LC_ALL=C sed -e 's/[^a-z0-9 -]//g' -e 's/ /-/g')"
    if printf '%s\n' "$slugs" | grep -qxF -- "$anchor"; then
      pass "anchor resolves: $target#$anchor"
    else
      fail "dangling anchor: $target#$anchor"
    fi
  fi
done < <(grep -oE '\]\(([^)]+)\)' "$DOC" | sed -e 's/^\](//' -e 's/)$//' | sort -u)

# ------------------------------------------------- 4. quoted figures match sources
# Format: <source-file-relative-to-root>|<verbatim substring that must exist>
PATTERN_CHECKS=(
  "docs/benchmarks.md|~11.8x smaller than JSON"
  "docs/benchmarks.md|~8.9x faster than JSON"
  "docs/benchmarks.md|**134 ns**"
  "docs/benchmarks.md|7,442,853 ops/s"
  "docs/benchmarks.md|1.19 µs"
  "docs/benchmarks.md|4,455.16"
  "docs/benchmarks.md|950.55"
  "docs/benchmarks.md|-78.66%"
  "docs/benchmarks.md|81 → 11"
  "docs/benchmarks.md|13,453.30"
  "docs/benchmarks.md|6,678.66"
  "docs/benchmarks.md|-50.36%"
  "docs/benchmarks.md|25,805.35 → 8,675.21"
  "docs/benchmarks.md|13,235.35 → 4,775.80"
  "docs/benchmarks.md|20.459"
  "docs/benchmarks.md|63.50–66.38%"
  "docs/benchmarks.md|59.80–63.92%"
  "docs/benchmarks.md|2.758 ms"
  "docs/benchmarks.md|16.863 µs"
  "docs/benchmarks.md|59,301"
  "docs/benchmarks.md|1.261 µs"
  "docs/benchmarks.md|793,185"
  "docs/benchmarks.md|2.273 µs"
  "docs/benchmarks.md|439,961"
  "docs/benchmarks.md|279.044 µs"
  "docs/benchmarks.md|~164x with the persistent loop"
  "docs/benchmarks.md|~2,188x with N-API Frame"
  "docs/benchmarks.md|1.0418x"
  "docs/benchmarks.md|1.0281x"
  "docs/benchmarks.md|0.9543x"
  "docs/benchmarks.md|1.0535x"
  "docs/wire-format.md|The 11.8× / 47 B claim, scoped"
  "docs/wire-format.md|It is not an end-to-end RTT claim."
  "docs/benchmark-receipts/2026-09-16-patch-performance-ab.json|4455.159993089681"
  "docs/benchmark-receipts/2026-09-16-patch-performance-ab.json|950.550060236484"
  "docs/benchmark-receipts/2026-09-16-patch-performance-ab.json|-78.66406455187096"
  "docs/benchmark-receipts/2026-09-16-patch-performance-ab.json|13453.29783668834"
  "docs/benchmark-receipts/2026-09-16-patch-performance-ab.json|6678.658269363982"
  "docs/benchmark-receipts/2026-09-16-patch-performance-ab.json|-50.35672033402333"
  "docs/benchmark-receipts/2026-09-16-tree-performance-ab.json|25805354.0"
  "docs/benchmark-receipts/2026-09-16-tree-performance-ab.json|8675208.333333334"
  "docs/benchmark-receipts/2026-09-16-tree-performance-ab.json|13235354.0"
  "docs/benchmark-receipts/2026-09-16-tree-performance-ab.json|4775795.9"
  "docs/benchmark-receipts/2026-08-24-host-matrix.json|2758485.2777777812"
  "docs/benchmark-receipts/2026-08-24-host-matrix.json|16863.163888889336"
  "docs/benchmark-receipts/2026-08-24-host-matrix.json|1260.7405555563084"
  "docs/benchmark-receipts/2026-08-24-host-matrix.json|2272.930000000181"
  "docs/benchmark-receipts/2026-08-24-host-matrix.json|279044.11764705885"
  "docs/benchmark-receipts/2026-08-24-host-matrix.json|793184.6053439161"
  "docs/benchmark-receipts/2026-08-24-host-matrix.json|439960.75550057436"
)

for entry in "${PATTERN_CHECKS[@]}"; do
  src="${entry%%|*}"
  needle="${entry#*|}"
  if [[ ! -f "$ROOT/$src" ]]; then
    fail "evidence source missing: $src"
    continue
  fi
  if grep -qF -- "$needle" "$ROOT/$src"; then
    pass "figure found in $src: $needle"
  else
    fail "figure NOT found in $src: $needle"
  fi
done

# ------------------------------------------------------------------- 5. summary
echo
echo "checks passed: $OKS, failed: $FAILS"
if (( FAILS > 0 )); then
  exit 1
fi
echo "All benchmark claims in benchmark-highlights.md are backed by existing files and verbatim sources."
