#!/usr/bin/env bash
set -u

# CI 필수 잡 집계 gate — .github/workflows/ci.yml 의 `gate` 잡이 호출한다.
# 스크립트는 <job>=<result> 인자 10개를 받아 전부 정확히 "success"일 때만 0으로
# 종료한다. skipped/cancelled 는 실패로 취급한다: consumer-smoke 는 typescript
# 실패 시 skip 되므로, skip 을 통과로 치면 체인 실패를 gate 가 놓친다.
#
# 판정 로직은 이 스크립트 하나로 추출돼 있다(scripts/ci-gate.test.ts 가 계약을
# 검증한다). 워크플로 잡은 판정 없이 needs.*.result 만 전달한다 — gate 로직의
# 단위 테스트는 가짜 workflow 실행 없이 로컬에서 돌아간다. bash 3.2 호환(macOS
# 시스템 bash 에서도 테스트 가능하게 declare -A 를 쓰지 않는다).

usage() {
  cat >&2 <<'EOF'
ci-gate.sh — CI 필수 잡 집계 gate

사용법:
  ci-gate.sh <job>=<result> ...   (필수 10개 인자)

<result> 값은 GitHub Actions needs.<job_id>.result 값 중 하나여야 한다:
  success | failure | cancelled | skipped

예시:
  ci-gate.sh rust=success rust-msrv=success ... consumer-smoke=success
EOF
}

# ── 인자 파싱 ────────────────────────────────────────────────────────────────
# needs 순서는 ci.yml gate 잡의 needs 리스트와 정확히 일치해야 한다.
expected_jobs=(
  rust
  rust-msrv
  rust-wasm32
  rust-audit
  rust-deny
  napi
  typescript
  rn-android
  rn-ios
  consumer-smoke
)

if [ "$#" -ne 10 ]; then
  echo "ci-gate.sh: exactly 10 job=result arguments required, got $#" >&2
  usage
  exit 2
fi

# ── 판정 ────────────────────────────────────────────────────────────────────
# 전부 정확히 "success"여야만 통과다. unknown 값('weird' 등)은 조용한 통과 대신
# 실패로 분류한다 — gate의 신뢰 계약은 "모르는 값은 red"다.
violations=""
seen_jobs=" "

for arg in "$@"; do
  case $arg in
    *=*)
      job=${arg%%=*}
      result=${arg#*=}
      ;;
    *)
      echo "ci-gate.sh: malformed argument '$arg' (expected <job>=<result>, e.g. rust=success)" >&2
      usage
      exit 2
      ;;
  esac

  # 인자가 실제 필수 잡인지 검증 — 오타 잡 이름은 조용한 통과 대신 hard error.
  known=0
  for j in "${expected_jobs[@]}"; do
    if [ "$j" = "$job" ]; then
      known=1
      break
    fi
  done
  if [ "$known" -eq 0 ]; then
    echo "ci-gate.sh: unknown job '$job' (expected: ${expected_jobs[*]})" >&2
    exit 2
  fi

  # 중복 금지 — 10개 인자가 중복을 포함하면 어떤 필수 잡이 검사되지 않은 채
  # PASS 로 빠진다(전부 success 여도 계약 위반이다).
  case $seen_jobs in
    *" $job "*)
      echo "ci-gate.sh: duplicate job '$job'" >&2
      exit 2
      ;;
  esac
  seen_jobs="$seen_jobs$job "

  if [ "$result" != "success" ]; then
    violations="$violations  fail  $job: $result\n"
  fi
done

# 누락 금지 — 인자 개수가 10개여도 중복 없이 잡이 빠지는 조합은 없지만, 스크립트
# 계약을 자체 완결적으로 유지하기 위해 커버리지를 다시 단언한다.
for j in "${expected_jobs[@]}"; do
  case $seen_jobs in
    *" $j "*) ;;
    *)
      echo "ci-gate.sh: missing job '$j'" >&2
      exit 2
      ;;
  esac
done

if [ -z "$violations" ]; then
  echo "gate: PASS — 모든 필수 잡 success (10/10)"
  for job in "$@"; do
    echo "  ok   ${job%%=*}"
  done
  exit 0
fi

echo "gate: FAIL — 필수 잡 중 green이 아닌 잡:" >&2
printf '%b' "$violations" >&2
exit 1
