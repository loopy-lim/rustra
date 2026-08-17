#!/bin/sh
# rustra runner 템플릿 — Lynx 용 Rust iOS static library 크로스컴파일.
# 스파이크 examples/lynx-calculator/modules/rustra-lynx/ios/build-rust-ios.sh 에서 정제 추출.
# 차이: 빌드 대상이 템플릿 backend(독립 workspace) — repo root 가 아닌 ../../backend.
set -eu

MODULE_DIR=$(cd "$(dirname "$0")" && pwd)
BACKEND_DIR=$(cd "$MODULE_DIR/../../../backend" && pwd)
TEMPLATE_ROOT=$(cd "$BACKEND_DIR/.." && pwd)
TARGET=${RUSTRA_IOS_TARGET:-aarch64-apple-ios-sim}
CARGO_BIN=${CARGO_BIN:-"$HOME/.cargo/bin/cargo"}
RUSTUP_BIN=${RUSTUP_BIN:-"$(command -v rustup || echo "$HOME/.cargo/bin/rustup")"}
# 표준 레이아웃(~/.cargo, ~/.rustup) 우선 — rustup 이 homebrew 심링크인 기계는
# RUSTUP_BIN 상대 계산이 무의미하므로 기본 경로로 폴백한다.
if [ -d "$HOME/.rustup" ]; then
  export RUSTUP_HOME=${RUSTUP_HOME:-"$HOME/.rustup"}
fi
export CARGO_HOME=${CARGO_HOME:-"$HOME/.cargo"}
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-"$TEMPLATE_ROOT/target"}
export RUSTUP_TOOLCHAIN=${RUSTUP_TOOLCHAIN:-stable-aarch64-apple-darwin}
export RUSTC=${RUSTC:-"$("$RUSTUP_BIN" which rustc 2>/dev/null || echo "$HOME/.cargo/bin/rustc")"}

# RUSTRA_PROFILE=release (default, frozen) | debug (debug_assertions ON → mutable registry)
PROFILE=${RUSTRA_PROFILE:-release}
if [ "$PROFILE" = "release" ]; then
  REL_FLAG="--release"
else
  REL_FLAG=""
fi

"$CARGO_BIN" build \
  --manifest-path "$BACKEND_DIR/Cargo.toml" \
  --lib \
  $REL_FLAG \
  --target "$TARGET"

mkdir -p "$MODULE_DIR/rust/lib"
cp "$CARGO_TARGET_DIR/$TARGET/$PROFILE/librustra_template_backend.a" \
   "$MODULE_DIR/rust/lib/librustra_template_backend.a"
