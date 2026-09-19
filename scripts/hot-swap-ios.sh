#!/usr/bin/env bash
set -euo pipefail

# iOS 시뮬레이터 핫스왑 진입 — examples/tauri-calculator README 의 문서화된 수동
# 4단계(tauri ios build → simctl install → get_app_container → 컨테이너로 아티팩트
# 복사 + SIMCTL_CHILD_ launch)를 한 커맨드로 묶는다. 이 스크립트가 존재하는 이유는
# 재설치마다 바뀌는 앱 컨테이너 경로(README 가 기록한 pain)를 매 실행
# `simctl get_app_container` 로 재해석해 대신 고정해주기 위해서다.
#
# 아티팩트 경로 계약은 packages/cli/src/dev-dylib.ts 의 liveArtifactPath 를 따른다:
# 시뮬레이터 트리플 디렉터리(target/<triple>/<profile>/)에서 stem 뒤에 -hot-live 를
# 붙인 게이트 발행 이름(lib<crate_underscored>-hot-live.dylib)을 먼저 보고, 없으면
# cargo 가 내놓는 평범한 cdylib 로 폴백한다. 컨테이너로의 스테이징도 같은 원자적
# 발행 계약을 따른다 — tmp 복사 뒤 rename 이며, 제자리 덮어쓰기는 매핑된 dylib 을
# 손상시키므로 금지(README 4단계, publishGatedArtifact 와 같은 이유).
#
# 모든 경로·id 는 RUSTRA_HOT_IOS_* 환경변수로 겹쳐 쓸 수 있다 — usage 참고.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXAMPLE_DIR="$REPO_ROOT/examples/tauri-calculator"
HOT_CONFIG="$EXAMPLE_DIR/rustra.hot.json"

BUILD=0
DRY_RUN=0
CLEANUP_TMP=""
CRATE="${RUSTRA_HOT_IOS_CRATE:-}"
MANIFEST="${RUSTRA_HOT_IOS_MANIFEST:-}"
BUNDLE_ID="${RUSTRA_HOT_IOS_BUNDLE_ID:-dev.rustra.calculator}"
TRIPLE="${RUSTRA_HOT_IOS_TRIPLE:-aarch64-apple-ios-sim}"
PROFILE="${RUSTRA_HOT_IOS_PROFILE:-release}"
TARGET_DIR="${RUSTRA_HOT_IOS_TARGET_DIR:-$REPO_ROOT/target}"

usage() {
  cat <<'EOF'
Usage: scripts/hot-swap-ios.sh [--build] [--dry-run]

  examples/tauri-calculator iOS 시뮬레이터 핫스왑 진입 — 부팅된 iPhone 시뮬레이터에
  앱을 설치하고, 핫코어 dylib 을 앱 데이터 컨테이너로 원자적 rename 으로 스테이징한
  뒤, SIMCTL_CHILD_RUSTRA_HOT_CORE 를 지정해 실행한다.

  --build    문서화된 빌드 단계(프론트엔드 → tauri ios build → 시뮬레이터 cdylib)를 먼저 실행
  --dry-run  변경 커맨드는 출력만 하고 실행하지 않는다(읽기 전용 해석은 수행)

환경변수 오버라이드:
  RUSTRA_HOT_IOS_UDID            대상 UDID (기본: 부팅된 첫 iPhone 시뮬레이터)
  RUSTRA_HOT_IOS_DYLIB           소스 dylib 직접 지정 — 이 값을 주면 파생을 생략
  RUSTRA_HOT_IOS_CRATE           rust 패키지명 (기본: rustra.hot.json codegen.rustPackage)
  RUSTRA_HOT_IOS_MANIFEST        cargo 매니페스트 (기본: rustra.hot.json codegen.rustManifest)
  RUSTRA_HOT_IOS_TARGET_DIR      cargo 타깃 디렉터리 (기본: <repo>/target)
  RUSTRA_HOT_IOS_TRIPLE          cargo 타깃 트리플 (기본: aarch64-apple-ios-sim)
  RUSTRA_HOT_IOS_PROFILE         cargo 프로필 디렉터리 (기본: release)
  RUSTRA_HOT_IOS_BUNDLE_ID       앱 bundle id (기본: dev.rustra.calculator)
  RUSTRA_HOT_IOS_APP             설치할 .app 경로 (기본: gen/apple/build/arm64-sim 아래 산출물)
  RUSTRA_HOT_IOS_CONSOLE=1       simctl launch 에 --console-pty 를 붙인다(블로킹)
  RUSTRA_HOT_IOS_SKIP_INSTALL=1  simctl install 생략 — 실행 중인 설치에 dylib 만 재스테이징
EOF
}

for arg in "$@"; do
  case "$arg" in
    --build) BUILD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 64 ;;
  esac
done

cleanup() {
  if [[ "$DRY_RUN" -eq 0 && -n "$CLEANUP_TMP" ]]; then
    rm -f -- "$CLEANUP_TMP" 2>/dev/null || true
  fi
}
trap cleanup EXIT

log() { echo "hot-swap-ios: $*"; }

fail() {
  local line
  for line in "$@"; do echo "hot-swap-ios: error: $line" >&2; done
  exit 1
}

# 변경 커맨드는 dry-run 에서 실행하지 않는다 — 읽기 전용 해석(simctl list,
# get_app_container, 존재 검사)은 dry-run 에서도 실제로 돌린다. 출력은 실행 커맨드와
# 같은 "+ ..." 형태라 그대로 붙여넣어 재현할 수 있다.
run() {
  echo "+ $*"
  if [[ "$DRY_RUN" -eq 0 ]]; then "$@"; fi
}

run_in() {
  local dir="$1"
  shift
  echo "+ (cd $dir && $*)"
  if [[ "$DRY_RUN" -eq 0 ]]; then (cd "$dir" && "$@"); fi
}

# rustra.hot.json 의 codegen 필드를 읽는다 — bash 에 JSON 파서가 없으므로 repo 가
# 이미 요구하는 런타임(node/bun/python3) 중 하나를 빌려 쓴다. stdout 이 값이다.
read_hot_config_field() {
  local field="$1"
  if command -v node >/dev/null 2>&1; then
    node -e 'const c = require(process.argv[1]); const v = (c.codegen || {})[process.argv[2]]; if (typeof v === "string") process.stdout.write(v);' \
      "$HOT_CONFIG" "$field" 2>/dev/null
  elif command -v bun >/dev/null 2>&1; then
    bun -e 'const c = require(process.argv[1]); const v = (c.codegen || {})[process.argv[2]]; if (typeof v === "string") process.stdout.write(v);' \
      "$HOT_CONFIG" "$field" 2>/dev/null
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json, sys
c = json.load(open(sys.argv[1]))
v = (c.get("codegen") or {}).get(sys.argv[2])
sys.stdout.write(v if isinstance(v, str) else "")' \
      "$HOT_CONFIG" "$field" 2>/dev/null
  else
    return 1
  fi
}

# CRATE/MANIFEST 채우기 — 둘 다 채워지면 0, 아니면 1. 실패 정책은 호출부가 결정한다
# (--build 에선 치명적, 아티팩트 부재 안내에선 비치명적 폴백).
load_hot_config() {
  local rel
  if [[ -z "$CRATE" ]]; then
    CRATE="$(read_hot_config_field rustPackage || true)"
  fi
  if [[ -z "$MANIFEST" ]]; then
    rel="$(read_hot_config_field rustManifest || true)"
    if [[ -n "$rel" ]]; then
      MANIFEST="$EXAMPLE_DIR/$rel"
    fi
  fi
  [[ -n "$CRATE" && -n "$MANIFEST" ]]
}

resolve_artifact() {
  local lib_stem artifact_dir gated plain
  if [[ -n "${RUSTRA_HOT_IOS_DYLIB:-}" ]]; then
    [[ -f "$RUSTRA_HOT_IOS_DYLIB" ]] ||
      fail "RUSTRA_HOT_IOS_DYLIB does not exist: $RUSTRA_HOT_IOS_DYLIB"
    ARTIFACT="$RUSTRA_HOT_IOS_DYLIB"
    log "artifact (RUSTRA_HOT_IOS_DYLIB override): $ARTIFACT"
    return 0
  fi
  load_hot_config || true
  if [[ -z "$CRATE" ]]; then
    fail "cannot derive the hot-core dylib path without the crate name" \
      "set RUSTRA_HOT_IOS_CRATE=rustra-calculator-example (or RUSTRA_HOT_IOS_DYLIB=<abs path>)"
  fi
  lib_stem="lib${CRATE//-/_}"
  artifact_dir="$TARGET_DIR/$TRIPLE/$PROFILE"
  gated="$artifact_dir/$lib_stem-hot-live.dylib"
  plain="$artifact_dir/$lib_stem.dylib"
  if [[ -f "$gated" ]]; then
    ARTIFACT="$gated"
    log "artifact (gated -hot-live publish, dev-dylib.ts contract): $ARTIFACT"
  elif [[ -f "$plain" ]]; then
    ARTIFACT="$plain"
    log "artifact (plain cdylib; no gated -hot-live publish found): $ARTIFACT"
  else
    [[ -n "$MANIFEST" ]] || MANIFEST="$REPO_ROOT/examples/calculator/Cargo.toml"
    fail "no simulator hot-core dylib found. Looked for:" \
      "  $gated" \
      "  $plain" \
      "build it with:" \
      "  cargo build --manifest-path $MANIFEST --package $CRATE --lib --release --target $TRIPLE" \
      "or run: scripts/hot-swap-ios.sh --build"
  fi
}

resolve_udid() {
  local booted re name udid first_any="" first_iphone=""
  if ! booted="$(xcrun simctl list devices booted 2>/dev/null)"; then
    fail "xcrun simctl list devices failed — is Xcode installed and licensed?" \
      "verify with: xcodebuild -version"
  fi
  re='^(.+) \(([0-9A-Fa-f-]{36})\) \(Booted\)$'
  while IFS= read -r line; do
    # simctl 은 행 끝에 공백을 붙여 내놓는다 — 정규화 후 정밀 일치.
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ "$line" =~ $re ]] || continue
    name="${BASH_REMATCH[1]}"
    udid="${BASH_REMATCH[2]}"
    if [[ -z "$first_any" ]]; then
      first_any="$udid"
    fi
    if [[ -z "$first_iphone" && "$name" == iPhone* ]]; then
      first_iphone="$udid"
    fi
  done < <(printf '%s\n' "$booted")
  if [[ -n "${RUSTRA_HOT_IOS_UDID:-}" ]]; then
    if ! printf '%s\n' "$booted" | grep -Fq "(${RUSTRA_HOT_IOS_UDID})"; then
      fail "RUSTRA_HOT_IOS_UDID=$RUSTRA_HOT_IOS_UDID is not a booted simulator" \
        "check: xcrun simctl list devices booted"
    fi
    UDID="$RUSTRA_HOT_IOS_UDID"
    log "simulator (RUSTRA_HOT_IOS_UDID override): $UDID"
    return 0
  fi
  if [[ -n "$first_iphone" ]]; then
    UDID="$first_iphone"
  elif [[ -n "$first_any" ]]; then
    UDID="$first_any"
    log "no booted iPhone found, using first booted simulator: $UDID"
  else
    fail "no booted iOS simulator found" \
      "open the Simulator app and boot an iPhone:" \
      "  open -a Simulator" \
      "or from the CLI:" \
      "  xcrun simctl list devices available" \
      "  xcrun simctl boot <UDID>"
  fi
  log "simulator: $UDID"
}

main() {
  command -v xcrun >/dev/null 2>&1 ||
    fail "xcrun not found — install the Xcode Command Line Tools: xcode-select --install"

  if [[ "$BUILD" -eq 1 ]]; then
    command -v bun >/dev/null 2>&1 ||
      fail "bun not found — required for the documented build steps. Install: https://bun.sh"
    command -v cargo >/dev/null 2>&1 ||
      fail "cargo not found — install the Rust toolchain: https://rustup.rs"
    xcodebuild -version >/dev/null 2>&1 ||
      fail "xcodebuild is not usable — install full Xcode and select it:" \
        "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
    load_hot_config ||
      fail "cannot read codegen.rustPackage/rustManifest from ${HOT_CONFIG#$REPO_ROOT/}" \
        "set RUSTRA_HOT_IOS_CRATE and RUSTRA_HOT_IOS_MANIFEST, or install node/bun/python3"
    [[ -d "$EXAMPLE_DIR/src-tauri/gen/apple" ]] ||
      fail "the tauri iOS project is not initialized" \
        "run once: (cd examples/tauri-calculator && bunx tauri ios init)"

    log "build 1/3 frontend"
    run_in "$EXAMPLE_DIR" bun run build:frontend
    log "build 2/3 tauri ios app (aarch64-sim, debug)"
    run_in "$EXAMPLE_DIR" bunx tauri ios build --target aarch64-sim --debug
    log "build 3/3 simulator cdylib ($TRIPLE, $PROFILE)"
    cargo_args=(build --manifest-path "$MANIFEST" --package "$CRATE" --lib)
    case "$PROFILE" in
      release) cargo_args+=(--release) ;;
      debug) ;;
      *) cargo_args+=(--profile "$PROFILE") ;;
    esac
    cargo_args+=(--target "$TRIPLE")
    run cargo "${cargo_args[@]}"
  fi

  resolve_artifact
  resolve_udid

  if [[ "${RUSTRA_HOT_IOS_SKIP_INSTALL:-0}" != "1" ]]; then
    APP="${RUSTRA_HOT_IOS_APP:-$EXAMPLE_DIR/src-tauri/gen/apple/build/arm64-sim/Rustra Tauri Calculator.app}"
    if [[ ! -d "$APP" ]]; then
      if [[ -d "$EXAMPLE_DIR/src-tauri/gen/apple" ]]; then
        fail "no simulator app bundle at: $APP" \
          "build it: scripts/hot-swap-ios.sh --build" \
          "or manually: (cd examples/tauri-calculator && bunx tauri ios build --target aarch64-sim --debug)"
      fi
      fail "the tauri iOS project is not initialized" \
        "run once: (cd examples/tauri-calculator && bunx tauri ios init)"
    fi
    log "installing app"
    run xcrun simctl install "$UDID" "$APP"
  else
    log "RUSTRA_HOT_IOS_SKIP_INSTALL=1 — skipping simctl install"
  fi

  if ! CONTAINER="$(xcrun simctl get_app_container "$UDID" "$BUNDLE_ID" data)"; then
    fail "cannot resolve the data container of $BUNDLE_ID on $UDID" \
      "the app must be installed first — drop RUSTRA_HOT_IOS_SKIP_INSTALL or run:" \
      "  xcrun simctl install $UDID <path-to-.app>"
  fi
  log "app data container: $CONTAINER"

  DEST="$CONTAINER/Documents/hot-core.dylib"
  CLEANUP_TMP="$CONTAINER/Documents/.hot-core.dylib.tmp.$$"
  log "staging hot-core (tmp copy + rename — never overwrite a mapped dylib in place)"
  run cp "$ARTIFACT" "$CLEANUP_TMP"
  run mv -f "$CLEANUP_TMP" "$DEST"

  launch_args=(--terminate-running-process)
  if [[ "${RUSTRA_HOT_IOS_CONSOLE:-0}" == "1" ]]; then
    launch_args=(--console-pty --terminate-running-process)
    log "RUSTRA_HOT_IOS_CONSOLE=1 — launch blocks on the app console (ctrl-c to detach)"
  fi
  log "launching $BUNDLE_ID"
  run env "SIMCTL_CHILD_RUSTRA_HOT_CORE=$DEST" xcrun simctl launch \
    "${launch_args[@]}" "$UDID" "$BUNDLE_ID"

  log "done. hot core path inside the app container: $DEST"
}

main
