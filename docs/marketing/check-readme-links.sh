#!/usr/bin/env bash
# Verify that every relative link in README.md resolves to a real file and,
# when present, to a real heading anchor (GitHub-style slug).
#
# Usage: bash docs/marketing/check-readme-links.sh
# Exits non-zero and prints each broken link if any fail.
set -u

cd "$(dirname "$0")/../.." || exit 1
readme=README.md
fail=0

slug() {
  # GitHub-style heading slug from a markdown heading line
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

while IFS= read -r link; do
  [ -n "$link" ] || continue
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
    if ! anchors_of "$file" | grep -qx "$anchor"; then
      echo "BROKEN anchor: ($link)"
      fail=1
    fi
  fi
done <<EOF
$links
EOF

if [ "$fail" -ne 0 ]; then
  echo "FAIL: broken relative links in $readme"
  exit 1
fi

echo "OK: all relative links in $readme resolve ($(printf '%s\n' "$links" | wc -l | tr -d ' ') unique targets)"
