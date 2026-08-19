#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEEP=0
DRY_RUN=0

usage() {
  cat <<'EOF'
Usage: scripts/clean-local.sh [--deep] [--dry-run]

  --deep     build outputs와 함께 node_modules, Pods, 로컬 패키지 캐시 제거
  --dry-run  삭제하지 않고 대상과 예상 확보 용량만 출력
EOF
}

for arg in "$@"; do
  case "$arg" in
    --deep) DEEP=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 64 ;;
  esac
done

shopt -s nullglob

BUILD_TARGETS=(
  "$REPO_ROOT/target"
  "$REPO_ROOT/dist"
  "$REPO_ROOT/dist-ts"
  "$REPO_ROOT"/*.tsbuildinfo
  "$REPO_ROOT"/packages/*/dist
  "$REPO_ROOT"/packages/*/dist-test
  "$REPO_ROOT/examples/calculator/dist-ts"
  "$REPO_ROOT/examples/calculator-napi"/*.node
  "$REPO_ROOT/examples/tauri-calculator/dist/examples"
  "$REPO_ROOT/examples/tauri-calculator/dist/packages"
  "$REPO_ROOT/examples/react-native-calculator/.expo"
  "$REPO_ROOT/examples/react-native-calculator/android/.gradle"
  "$REPO_ROOT/examples/react-native-calculator/android/build"
  "$REPO_ROOT/examples/react-native-calculator/android/app/build"
  "$REPO_ROOT/examples/react-native-calculator/android/app/.cxx"
  "$REPO_ROOT/examples/react-native-calculator/ios/build"
  "$REPO_ROOT/examples/react-native-calculator/modules/nitro-bench/nitro-bench/.expo"
  "$REPO_ROOT/examples/react-native-calculator/modules/nitro-bench/nitro-bench/android/build"
  "$REPO_ROOT/examples/react-native-calculator/modules/nitro-bench/nitro-bench/android/.cxx"
  "$REPO_ROOT/examples/react-native-calculator/modules/rustra-jsi/android/build"
  "$REPO_ROOT/examples/react-native-calculator/modules/rustra-jsi/android/.cxx"
  "$REPO_ROOT/examples/react-native-calculator/modules/rustra-jsi/android/src/main/cpp/libs"
  "$REPO_ROOT/examples/react-native-calculator/modules/rustra-jsi/ios/rust/lib"
  "$REPO_ROOT/fuzz/target"
  "$REPO_ROOT/fuzz/artifacts"
  "$REPO_ROOT/fuzz/coverage"
  "$REPO_ROOT/scripts/swift-ffi-bench/benchmark"
)

DEEP_TARGETS=(
  "$REPO_ROOT/.npm-cache"
  "$REPO_ROOT/node_modules"
  "$REPO_ROOT/examples/calculator-napi/node_modules"
  "$REPO_ROOT/examples/react-native-calculator/node_modules"
  "$REPO_ROOT/examples/react-native-calculator/ios/Pods"
  "$REPO_ROOT/examples/react-native-calculator/modules/nitro-bench/nitro-bench/node_modules"
)

TARGETS=("${BUILD_TARGETS[@]}")
if [[ $DEEP -eq 1 ]]; then
  TARGETS+=("${DEEP_TARGETS[@]}")
fi

EXISTING=()
TOTAL_KIB=0
for path in "${TARGETS[@]}"; do
  if [[ -e "$path" || -L "$path" ]]; then
    relative_path="${path#"$REPO_ROOT/"}"
    if [[ "$relative_path" == "$path" || "$relative_path" == ..* ]]; then
      echo "Refusing path outside repository: $path" >&2
      exit 1
    fi
    tracked_path=$(git -C "$REPO_ROOT" ls-files -- "$relative_path")
    if [[ -n "$tracked_path" ]]; then
      echo "Refusing target that contains tracked files: $relative_path" >&2
      exit 1
    fi
    EXISTING+=("$path")
    if [[ -d "$path" && ! -L "$path" ]]; then
      size_kib=$(du -sk "$path" | awk '{print $1}')
    else
      size_kib=$(du -k "$path" | awk '{print $1}')
    fi
    TOTAL_KIB=$((TOTAL_KIB + size_kib))
    printf '%8d MiB  %s\n' "$(((size_kib + 512) / 1024))" "$relative_path"
  fi
done

if [[ ${#EXISTING[@]} -eq 0 ]]; then
  echo "Nothing to clean."
  exit 0
fi

awk -v kib="$TOTAL_KIB" -v count="${#EXISTING[@]}" \
  'BEGIN { printf "Total: %.1f GiB (%d paths)\n", kib / 1048576, count }'

if [[ $DRY_RUN -eq 1 ]]; then
  echo "Dry run: no files removed."
  exit 0
fi

for path in "${EXISTING[@]}"; do
  rm -rf -- "$path"
done

echo "Clean complete."
