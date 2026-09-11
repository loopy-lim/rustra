#!/usr/bin/env bash
set -euo pipefail

# UniFFI Android 스모크 — 생성 바인딩과 빌드된 .so 를 앱 소스 트리로 동기화한다.
#
# 커밋 금지 산출물(.kt 사본, jniLibs/*.so)을 만드는 스크립트다. 생성 바인딩의
# 단일 진실원은 examples/calculator/uniffi 커밋물이고, 스모크 앱은 빌드 시점에
# 이를 복사해 소비한다(스모크 디렉터리에 바인딩 사본을 커밋하지 않는다).
#
# 사전 조건:
#   1. cargo build -p rustra-calculator-example --features uniffi \
#        --target <android-triple>   (cargo-ndk 사용 권장 — CI 와 동일 링커 경로)
#   2. NDK 링커 — cargo-ndk 는 NDK_HOME/ANDROID_NDK_HOME 환경변수를 요구한다.
#
# 사용법:
#   ./sync-bindings.sh [debug|release]   # 기본값 debug

PROFILE="${1:-debug}"
case "$PROFILE" in
  debug | release) ;;
  *)
    echo "sync-bindings.sh: profile must be debug or release (got '$PROFILE')" >&2
    exit 2
    ;;
esac

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
KT_SRC="$ROOT/examples/calculator/uniffi/uniffi/rustra_calculator_example/rustra_calculator_example.kt"
APP_SRC_UNIFFI="$ROOT/examples/uniffi-android-smoke/app/src/main/java/uniffi/rustra_calculator_example"
JNILIBS="$ROOT/examples/uniffi-android-smoke/app/src/main/jniLibs"

# ── 1. Kotlin 바인딩 사본 ────────────────────────────────────────────────────
if [ ! -f "$KT_SRC" ]; then
  echo "sync-bindings.sh: 생성 바인딩이 없다: $KT_SRC" >&2
  echo "  examples/calculator 의 uniffi 코드젠 산출이 커밋돼 있어야 한다." >&2
  exit 1
fi
mkdir -p "$APP_SRC_UNIFFI"
cp "$KT_SRC" "$APP_SRC_UNIFFI/rustra_calculator_example.kt"
echo "synced: $(basename "$KT_SRC") -> ${APP_SRC_UNIFFI#$ROOT/}/"

# ── 1b. (제거됨) Kotlin 호환 shim ────────────────────────────────────────────
# 예전 생성 바인딩은 RustraCommandFailure.Failure 의 `message` 필드가
# Throwable.message 오버라이드와 충돌해 Kotlin 컴파일이 깨졌고, 이 스크립트가
# 사본에 sed shim 을 발렀다. 근복 수정이 렌더러에 착지했다
# (examples/calculator/src/uniffi_render.rs — 필드명 `detail` 회피, 2026-09-11),
# 바인딩 재생성 후에는 shim 이 필요 없다. recency 마커도 함께 제거했다.

# ── 2. 네이티브 라이브러리 (triple → ABI 매핑, bash 3.2 호환 케이스문) ────────
sync_so() {
  triple=$1
  abi=$2
  so="$ROOT/target/$triple/$PROFILE/librustra_calculator_example.so"
  if [ ! -f "$so" ]; then
    echo "sync-bindings.sh: .so 가 없다: $so" >&2
    echo "  먼저 실행: cargo ndk -t ${abi} -p $PROFILE -- build -p rustra-calculator-example --features uniffi" >&2
    exit 1
  fi
  mkdir -p "$JNILIBS/$abi"
  cp "$so" "$JNILIBS/$abi/librustra_calculator_example.so"
  echo "synced: $triple/$PROFILE -> jniLibs/$abi/"
}

# 에뮬레이터는 x86_64, 실기기 호환용 arm64-v8a. 하나만 빌드해도 동기화 가능.
for pair in "x86_64-linux-android:x86_64" "aarch64-linux-android:arm64-v8a"; do
  triple=${pair%%:*}
  abi=${pair##*:}
  if [ -f "$ROOT/target/$triple/$PROFILE/librustra_calculator_example.so" ]; then
    sync_so "$triple" "$abi"
  else
    echo "skip: target/$triple/$PROFILE .so 없음 (빌드하지 않았으면 정상)"
  fi
done

# 최소 1개 ABI 는 반드시 있어야 APK 가 의미가 있다.
if [ -z "$(ls -A "$JNILIBS" 2>/dev/null)" ]; then
  echo "sync-bindings.sh: 동기화된 .so 가 하나도 없다 — 먼저 cargo 빌드를 실행하라" >&2
  exit 1
fi
