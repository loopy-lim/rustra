#!/usr/bin/env bash
# Verify that every relative link in README.ko.md resolves to a real file.
# ASCII-only heading anchors are additionally validated as GitHub-style slugs;
# non-ASCII (Korean) anchors are noted but skipped.
#
# Usage: bash docs/marketing/check-readme-links-ko.sh
# Exits non-zero and prints each broken link if any fail.
set -u

cd "$(dirname "$0")/../.." || exit 1
readme=README.ko.md
fail=0

slug() {
  # GitHub-style heading slug from a markdown heading line (ASCII approximation)
  local text
  text=$(printf '%s' "$1" | sed 's/^#*//; s/^[[:space:]]*//; s/[[:space:]]*$//')
  text=$(printf '%s' "$text" | tr -d '`*_')
  text=$(printf '%s' "$text" | tr '[:upper:]' '[:lower:]')
  text=$(printf '%s' "$text" | LC_ALL=C sed 's/[^a-z0-9 -]//g')
  text=$(printf '%s' "$text" | sed 's/ /-/g')
  printf '%s' "$text"
}

anchors_of() {
  # Print all GitHub-style slugs of headings in a markdown file
  local file="$1"
  grep -E '^#{1,6} ' "$file" 2>/dev/null | while IFS= read -r line; do
    slug "$line"
    printf '\n'
  done
}

# Collect unique relative link targets (markdown-style `](...)`)
links=$(grep -oE '\]\([^)]+\)' "$readme" \
  | sed 's/^](//; s/)$//' \
  | grep -vE '^(https?|mailto):' \
  | sort -u)

if [ -z "$links" ]; then
  echo "no relative links found in $readme"
  exit 0
fi

checked=0
while IFS= read -r link; do
  [ -n "$link" ] || continue
  checked=$((checked + 1))
  target="${link%%#*}"
  anchor=""
  case "$link" in
    *"#"*) anchor="${link#*#}" ;;
  esac

  if [ -z "$target" ]; then
    file="$readme"
  else
    file="$target"
    if [ ! -e "$file" ]; then
      echo "BROKEN file: ($link)"
      fail=1
      continue
    fi
  fi

  if [ -n "$anchor" ]; then
    case "$anchor" in
      # Best-effort: only validate anchors that are pure ASCII after slug rules
      *[!\ -~]*)
        echo "SKIP anchor (non-ASCII): ($link)"
        ;;
      *)
        if ! anchors_of "$file" | grep -qxF "$anchor"; then
          echo "BROKEN anchor: ($link)"
          fail=1
        fi
        ;;
    esac
  fi
done <<EOF
$links
EOF

if [ "$fail" -eq 0 ]; then
  echo "OK: $checked unique relative links in $readme all resolve to real files"
else
  echo "FAIL: broken links found in $readme"
fi
exit $fail
