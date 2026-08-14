#!/usr/bin/env bash
# rustra runner 템플릿 → 새 프로젝트 인스턴스화.
#
# 사용:
#   ./runner/template/create-runner.sh <app-name> [rust-package-id] [out-dir]
#
# 예:
#   ./runner/template/create-runner.sh my-app com.example.myapp
#   → ../my-app/  생성.
#
# 수행:
#   1. 템플릿 전체 복사(target/, node_modules/, dist/, generated/ 제외).
#   2. 식별자 치환:
#        rustra-template-backend → <app>-backend   (crate 명)
#        rustra-template-app     → <app>-app       (npm 명)
#        template.app            → <rust-package-id or <app>.app>  (rustra 패키지 ID)
#        rustra_template_        → rustra_<app_safe>_   (FFI 심볼 prefix; '-'→'_')
#   3. 안내: 첫 codegen + 각 플랫폼 빌드 순서.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <app-name> [rust-package-id] [out-dir]" >&2
  echo "  e.g. $0 my-app com.example.myapp" >&2
  exit 64
fi

APP="$1"
PKG_ID="${2:-${APP}.app}"
OUT_DIR="${3:-../$(basename "$APP")}"
HERE="$(cd "$(dirname "$0")" && pwd)"

# FFI 식별자 안전화: '-' → '_' (Rust extern "C" 심볼은 하이픈 불가).
# bash 파라미터 확장으로 echo 의 trailing newline 이 섞이지 않게.
APP_SAFE="${APP//-/_}"
PREFIX_OLD="rustra_template_"
PREFIX_NEW="rustra_${APP_SAFE}_"

echo "== rustra runner: instantiate '$APP' (pkg=$PKG_ID) → $OUT_DIR"

# 1. 복사 (빌드 산출물 제외)
mkdir -p "$OUT_DIR"
rsync -a --exclude '/target' --exclude '/node_modules' --exclude '/dist' \
  --exclude '/generated' --exclude '.git' \
  "$HERE/" "$OUT_DIR/"

# 2. 식별자 치환 (대상 파일: .rs .toml .ts .tsx .json .sh .md .mm .kt .m .cpp)
mapfile -t FILES < <(grep -rIl \
  -e 'rustra-template-backend' \
  -e 'rustra-template-app' \
  -e 'template\.app' \
  -e 'rustra_template_' \
  "$OUT_DIR" 2>/dev/null || true)

# Crate import 명(하이픈→언더스코어): bin/generate.rs 가 `rustra_template_backend` 를 use 한다.
APP_SAFE_US="${APP//-/_}"

for f in "${FILES[@]}"; do
  sed -i.bak \
    -e "s/rustra-template-backend/${APP}-backend/g" \
    -e "s/rustra-template-app/${APP}-app/g" \
    -e "s/template\.app/${PKG_ID}/g" \
    -e "s/rustra_template_backend/${APP_SAFE_US}_backend/g" \
    -e "s/${PREFIX_OLD}/${PREFIX_NEW}/g" \
    "$f"
  rm -f "${f}.bak"
done

# 3. rustra path 의존성 재작성 (P7 완화) — 복사본은 repo 밖에 있으므로 상대 path 가 깨진다.
#    rustra-bridge 워크스페이스의 절대경로로 재작성한다 (published crate 사용 시 버전 핀으로 교체 권장).
TEMPLATE_ROOT="$(cd "$HERE" && pwd)"
BRIDGE_ROOT="$(cd "$TEMPLATE_ROOT/../.." && pwd)"
BACKEND_TOML="$OUT_DIR/backend/Cargo.toml"
if [[ -f "$BACKEND_TOML" ]]; then
  sed -i.bak "s|rustra = { path = \"../../../crates/rustra\" }|rustra = { path = \"${BRIDGE_ROOT}/crates/rustra\" }|" "$BACKEND_TOML"
  rm -f "${BACKEND_TOML}.bak"
  echo "== rustra path → ${BRIDGE_ROOT}/crates/rustra (절대경로 재작성)"
fi
# app/package.json 의 @rustra/lynx, @rustra/types file: 도 repo 밖에서 깨진다 — 절대경로로.
APP_PKG="$OUT_DIR/app/package.json"
if [[ -f "$APP_PKG" ]]; then
  sed -i.bak \
    -e "s|\"@rustra/lynx\": \"file:../../../packages/lynx\"|\"@rustra/lynx\": \"file:${BRIDGE_ROOT}/packages/lynx\"|" \
    -e "s|\"@rustra/types\": \"file:../../../packages/types\"|\"@rustra/types\": \"file:${BRIDGE_ROOT}/packages/types\"|" \
    "$APP_PKG"
  rm -f "${APP_PKG}.bak"
  echo "== @rustra/* file: deps → ${BRIDGE_ROOT}/packages/* (절대경로 재작성)"
fi

echo ""
echo "== 완료: $OUT_DIR"
echo "다음 단계:"
echo "  cd $OUT_DIR"
echo "  # 1. Rust 백엔드 command 작성/확장 (backend/src/lib.rs #[command])"
echo "  # 2. codegen 으로 generated/ 재생성 (app/ 안에서):"
echo "  (cd app && npm install && npm run codegen)"
echo "     ⚠️ rustra CLI 탐색: RUSTRA_CLI=<bridge>/packages/cli/dist/index.js env 권장"
echo "  # 3. ReactLynx 번들 빌드:"
echo "  (cd app && npm run build)"
echo "  # 4. 플랫폼 실행(각 run.sh):"
echo "  ./desktop/run.sh        # macOS (Windows 는 Windows 머신에서)"
echo "  ./mobile-ios/run.sh     # iOS 시뮬레이터"
echo "  ./mobile-android/run.sh # Android 에뮬레이터"
echo ""
echo "⚠️  FFI 심볼 prefix 가 rustra_template_ → ${PREFIX_NEW} 로 치환되었습니다."
echo "   각 플랫폼 셸(host.cpp / RustraModule.{m,kt}) 의 extern 선언도 같이 바뀝니다."
