#!/bin/sh
# rustra runner 템플릿 — Lynx 용 Rust Android static library 크로스컴파일 (cargo-ndk).
# 스파이크 examples/lynx-calculator/modules/rustra-lynx/android/build-rust-android.sh 에서
# 정제 추출 + P6 대응: NDK 버전 핀 + 경로 결정론적 검증.
#
# 요구:
#   cargo-ndk (`cargo install cargo-ndk`) + rustup target:
#     rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android i686-linux-android
#   Android SDK ($ANDROID_HOME 또는 $HOME/Library/Android/sdk) — NDK 27.1.12297006 핀.
set -eu

MODULE_DIR=$(cd "$(dirname "$0")" && pwd)
BACKEND_DIR=$(cd "$MODULE_DIR/../../../backend" && pwd)
TEMPLATE_ROOT=$(cd "$BACKEND_DIR/.." && pwd)
CARGO_BIN=${CARGO_BIN:-"$HOME/.cargo/bin/cargo"}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-"$TEMPLATE_ROOT/target"}

PROFILE=${RUSTRA_PROFILE:-release}
REL_FLAG=""
if [ "$PROFILE" = "release" ]; then
  REL_FLAG="--release"
fi

# ── P6: NDK 결정론적 선택 ─────────────────────────────────────────────
# 환경 ANDROID_NDK_HOME 이 SDK 루트를 가리키는 기계도 있으므로,
# $SDK/ndk/<핀 버전> 을 우선하고 실패 시 환경값으로 fallback, 둘 다 없으면 에러.
NDK_VERSION="${NDK_VERSION:-27.1.12297006}"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
PINNED_NDK="$SDK/ndk/$NDK_VERSION"

if [ -d "$PINNED_NDK" ]; then
  export ANDROID_NDK_HOME="$PINNED_NDK"
elif [ -n "${ANDROID_NDK_HOME:-}" ] && [ -d "$ANDROID_NDK_HOME" ]; then
  echo "==> WARN: pinned NDK $NDK_VERSION not found; using ANDROID_NDK_HOME=$ANDROID_NDK_HOME" >&2
else
  echo "ERROR: NDK not found." >&2
  echo "  expected: $PINNED_NDK" >&2
  echo "  install:  sdkmanager \"ndk;$NDK_VERSION\"  (or set ANDROID_NDK_HOME)" >&2
  exit 1
fi
echo "==> NDK $ANDROID_NDK_HOME (pin $NDK_VERSION)"

# rustup target 사전 검증 — 없으면 cargo-ndk 가 불명확하게 실패한다.
for t in aarch64-linux-android armv7-linux-androideabi x86_64-linux-android; do
  if ! "$HOME/.cargo/bin/rustup" target list --installed 2>/dev/null | grep -q "^$t$"; then
    echo "ERROR: rustup target '$t' not installed — rustup target add $t" >&2
    exit 1
  fi
done

# JNI 가 링크할 ABI 목록. ANDROID_ABIS 로 오버라이드 가능.
ABIS=${ANDROID_ABIS:-"aarch64-linux-android armv7-linux-androideabi x86_64-linux-android"}

mkdir -p "$MODULE_DIR/rust/lib"

for ABI in $ABIS; do
  echo "==> building $ABI"
  # cargo-ndk v4: cargo 인자는 trailing positional 로 전달. `--` 뒤에
  # cargo 바이너리 경로를 두면 cargo 가 그 파일을 -Zscript 대상으로 해석하므로
  # subcommand 키워드(build)만 넘긴다. (스파이크 검증 조합 그대로 — platform 플래그 없음)
  "$CARGO_BIN" ndk \
    --manifest-path "$BACKEND_DIR/Cargo.toml" \
    -t "$ABI" \
    -- build --lib $REL_FLAG

  # 독립 workspace들도 runner 루트 target을 공유한다.
  cp "$CARGO_TARGET_DIR/$ABI/$PROFILE/librustra_template_backend.a" \
     "$MODULE_DIR/rust/lib/librustra_template_backend-$ABI.a"
done
