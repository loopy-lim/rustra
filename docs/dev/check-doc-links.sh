#!/usr/bin/env bash
# Validate markdown links in all tracked markdown files under docs/.
#
# Policy:
#   - Checks relative links (foo.md, ./foo.md, ../foo.md) and root-relative
#     links (/docs/foo.md) against files that actually exist.
#   - Code fences and inline code spans are stripped first, so link syntax
#     inside code samples is not validated.
#   - Skips external links (http://, https://, mailto:, ftp://),
#     anchor-only links (#section), and targets containing whitespace
#     (not valid markdown link destinations).
#   - Absolute paths (/...) are treated as repo-root-relative only when the
#     first segment matches a tracked top-level entry; other absolute paths
#     (e.g. /tmp/...) point outside the repository and are skipped.
#   - Skips link targets that resolve to a git-untracked path: some
#     historical notes are intentionally kept as untracked originals
#     (e.g. docs/research/2026-09-24-*), so links to them are exempt
#     from validation rather than failures.
#   - Any other target that does not resolve to an existing file is a
#     failure.
set -uo pipefail
cd "$(dirname "$0")/../.."

total=0
broken=0
untracked_skips=0
external_abs_skips=0

while IFS=$'\t' read -r file target; do
  target=${target#<}; target=${target%>}
  path=${target%%#*}; path=${path%%\?*}
  [ -z "$path" ] && continue                            # anchor-only link
  case "$path" in
    http://*|https://*|mailto:*|ftp://*) continue ;;    # external link
    *" "*) continue ;;                                  # invalid link target
  esac
  case "$path" in
    /*) rel="${path#/}" ;;                              # root-relative / absolute
    *)  rel="$(dirname "$file")/$path" ;;               # relative
  esac
  rel=$(python3 -c 'import os,sys; print(os.path.normpath(sys.argv[1]))' "$rel")
  case "$path" in
    /*)
      top=${rel%%/*}
      if ! git ls-files -- "$top" | grep -q .; then
        external_abs_skips=$((external_abs_skips + 1))
        continue                                        # absolute path outside repo
      fi
      ;;
  esac
  total=$((total + 1))
  if [ -e "$rel" ]; then
    if git ls-files --error-unmatch "$rel" >/dev/null 2>&1 || [ -d "$rel" ]; then
      :
    else
      untracked_skips=$((untracked_skips + 1))          # untracked target: exempt
    fi
  else
    echo "BROKEN: $file -> $target"
    broken=$((broken + 1))
  fi
done < <(
  git ls-files -- 'docs' | grep '\.md$' | while IFS= read -r file; do
    # Strip fenced code blocks, then inline code spans, then extract links.
    awk '
      /^(```|~~~)/ { infence = !infence; next }
      infence { next }
      { print }
    ' "$file" | sed -E 's/`[^`]*`//g' \
      | grep -oE '\]\([^)]+\)' | sed -E 's/^\]\(//; s/\)$//' \
      | while IFS= read -r target; do printf '%s\t%s\n' "$file" "$target"; done
  done
)

echo "checked=$total broken=$broken skipped_untracked=$untracked_skips skipped_out_of_repo_abs=$external_abs_skips"
[ "$broken" -eq 0 ]
