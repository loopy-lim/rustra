#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
files=(README.md docs/marketing/benchmark-highlights.md docs/marketing/show-hn-draft.md)

for file in "${files[@]}"; do
  [[ -s "$file" ]] || { echo "FAIL: missing or empty: $file" >&2; exit 1; }
done

# The shared headline figures must remain present in all three marketing surfaces.
shared_figures=("4 B" "47 B" "11.8" "134 ns" "8.9" "793,185" "2,188" "363/s" "±5%")
for figure in "${shared_figures[@]}"; do
  for file in "${files[@]}"; do
    if ! grep -Fq -- "$figure" "$file"; then
      echo "FAIL: shared benchmark figure '$figure' missing from $file" >&2
      exit 1
    fi
  done
done

# Validate every relative Markdown link target (including image links); ignore URLs and anchors.
python3 - <<'PY'
import re
from pathlib import Path

sources = [Path("README.md"), Path("docs/marketing/benchmark-highlights.md"), Path("docs/marketing/show-hn-draft.md")]
link_re = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
errors = []
count = 0
for source in sources:
    text = source.read_text(encoding="utf-8")
    for raw in link_re.findall(text):
        target = raw.strip().split(maxsplit=1)[0].strip("<>")
        if re.match(r"^[A-Za-z][A-Za-z0-9+.-]*:", target) or target.startswith("//"):
            continue
        path, _, _anchor = target.partition("#")
        if not path:
            continue
        count += 1
        resolved = (source.parent / path).resolve()
        if not resolved.exists():
            errors.append(f"{source}: broken relative link: {target}")
if errors:
    print("\n".join(errors))
    raise SystemExit(1)
print(f"OK: {count} relative Markdown link targets resolve")
PY

for file in "${files[@]}"; do
  if perl -CSD -ne 'exit 1 if /\p{Hangul}/' "$file"; then
    :
  else
    echo "FAIL: Hangul detected in $file" >&2
    exit 1
  fi
done

echo "OK: shared benchmark figures appear in all three files"
echo "OK: no Hangul in README.md, benchmark-highlights.md, or show-hn-draft.md"
echo "Artifacts: README.md (first-screen pitch/demo/claims), docs/marketing/benchmark-highlights.md (evidence and scope), docs/marketing/show-hn-draft.md (submission draft)"
