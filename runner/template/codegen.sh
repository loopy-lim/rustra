#!/usr/bin/env bash
# rustra runner 템플릿 codegen — dual-path 왕복 (Rust bin → TS CLI).
#
# generated/ 재생성은 두 codegen 경로가 나뉘어 있어 한쪽만 돌리면 stale 발생
# (한쪽만 돌리면 code/types 는 맞지만 codec 이 stale):
#   1. Rust bin  → types.ts / commands.ts / contract.ts / schema.json
#   2. TS CLI    → rkyv-codecs.ts / rkyv-registry.ts
# 본 스크립트는 둘 다 순서대로 실행한다. `app/npm run codegen` 이 호출한다.
#
# in-repo(템플릿 원본) 에서는 packages/cli/dist 가 존재한다.
# create-runner.sh 로 외부 복사된 프로젝트는 RUSTRA_CLI/RUSTRA_REPO env 로 경로를
# 지정하거나 npm i -D @rustra/cli 로 설치한다.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$HERE/backend"
APP="$HERE/app"

# rustra CLI 위치: 명시 env > rustra-bridge 워크스페이스 내부 탐색.
# in-repo(템플릿 원본) 는 runner/template → rustra-bridge 루트(2단계 상위)에 있다.
find_repo_cli() {
  local dir="$HERE"
  for _ in 1 2 3 4 5; do
    dir="$(dirname "$dir")"
    if [[ -f "$dir/packages/cli/dist/index.js" ]]; then
      echo "$dir/packages/cli/dist/index.js"; return 0
    fi
  done
  return 1
}
if [[ -z "${RUSTRA_CLI:-}" ]]; then
  RUSTRA_CLI="$(find_repo_cli || true)"
fi

echo "[codegen] 1/2 Rust bin (types/commands/contract/schema)"
( cd "$BACKEND" && cargo run --quiet --bin generate >/dev/null )

if [[ ! -f "$RUSTRA_CLI" ]]; then
  echo "[codegen] WARN: rustra CLI 를 찾을 수 없음: $RUSTRA_CLI" >&2
  echo "           rkyv-codecs.ts / rkyv-registry.ts 건너뜀 — RUSTRA_CLI env 로 지정하거나" >&2
  echo "           npm i -D @rustra/cli 후 'npx rustra generate --schema generated/schema.json --output generated'" >&2
  exit 0
fi

echo "[codegen] 2/2 TS CLI (rkyv-codecs/rkyv-registry)"
( cd "$APP" && node "$RUSTRA_CLI" generate --schema generated/schema.json --output generated )

echo "[codegen] OK → $APP/generated"
