#!/usr/bin/env bash
set -euo pipefail
report="$(dirname "$0")/usage-audit.md"
test -s "$report"
# Every MISMATCH table row must provide an evidence command and a proposed correction.
awk -F'|' '
  /^\| MISMATCH / {
    rows++
    if ($3 ~ /^[[:space:]]*$/ || $6 ~ /^[[:space:]]*$/) bad=1
    if ($4 !~ /제안|올바른 표현|제안:/ && $4 !~ /[Pp]roposed|[Cc]orrect wording/) bad=1
    if ($7 ~ /^[[:space:]]*$/) bad=1
  }
  END { if (bad) exit 1 }
' "$report"
echo "OK: mismatch rows include evidence and correction proposals"
