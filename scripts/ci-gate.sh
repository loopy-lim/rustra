#!/usr/bin/env bash
set -u

# CI 필수 잡 집계 gate — .github/workflows/ci.yml 의 `gate` 잡이 호출한다.
# 스크립트는 <job>=<result> 인자 15개를 받아 전부 정확히 "success"일 때만 0으로
# 종료한다. 유일한 예외는 모바일 4잡(rn-android/rn-ios/uniffi-android/uniffi-ios)의
# "skipped" 다: 경로 필터 기인일 때만 통과로 인정한다 —
#   GATE_EVENT_NAME == "pull_request" && GATE_CHANGES_CODE == "false"
# (docs 전용 PR 에서 dorny/paths-filter 가 모바일 잡을 건너뛰는 설계된 skip).
# 그 외 모든 skipped/cancelled 는 실패로 취급한다: consumer-smoke 는 TS 계열
# 3잡(ts-checks/ts-tests/ts-runtime — 구 typescript 메가잡 분할, 2026-09-20)
# 실패 시 skip 되므로, skip 을 무조건 통과로 치면 체인 실패를 gate 가 놓친다.
# 컨텍스트 env 가 비어 있으면(구식 호출자) skip 은 절대 통과하지 않는 fail-safe 다.
#
# 판정 로직은 이 스크립트 하나로 추출돼 있다(scripts/ci-gate.test.ts 가 계약을
# 검증한다). 워크플로 잡은 판정 없이 needs.*.result 만 전달한다 — gate 로직의
# 단위 테스트는 가짜 workflow 실행 없이 로컬에서 돌아간다. bash 3.2 호환(macOS
# 시스템 bash 에서도 테스트 가능하게 declare -A 를 쓰지 않는다).

usage() {
  cat >&2 <<'EOF'
ci-gate.sh — CI 필수 잡 집계 gate

사용법:
  ci-gate.sh <job>=<result> ...   (필수 15개 인자)

<result> 값은 GitHub Actions needs.<job_id>.result 값 중 하나여야 한다:
  success | failure | cancelled | skipped

환경 변수(모바일 잡 skip 판정에 사용, 미설정 시 skip 은 항상 실패):
  GATE_EVENT_NAME    트리거 이벤트 (github.event_name, 예: pull_request, push)
  GATE_CHANGES_CODE  changes 잡의 경로 필터 출력 ("true" | "false")

예시:
  ci-gate.sh changes=success rust=success ... uniffi-ios=success
EOF
}

# ── 인자 파싱 ────────────────────────────────────────────────────────────────
# needs 순서는 ci.yml gate 잡의 needs 리스트와 정확히 일치해야 한다.
expected_jobs=(
  changes
  rust
  rust-msrv
  rust-wasm32
  rust-audit
  rust-deny
  napi
  ts-checks
  ts-tests
  ts-runtime
  rn-android
  rn-ios
  uniffi-android
  uniffi-ios
  consumer-smoke
)

expected_count=15

# 경로 필터 skip 이 허용되는 잡 — ci.yml 의 모바일 4잡과 정확히 일치해야 한다.
filter_skippable_jobs=" rn-android rn-ios uniffi-android uniffi-ios "

gate_event_name=${GATE_EVENT_NAME:-}
gate_changes_code=${GATE_CHANGES_CODE:-}

# 모바일 잡의 skipped 가 경로 필터 기인인지 판정한다: pull_request 이벤트이고
# changes.code 가 정확히 "false"(필터가 code 변경 없음을 확정)일 때만 참.
# "true"(코드가 바뀌었는데 skip — 이상 신호)도 빈 값(changes 잡 실패/구식
# 호출자)도 허용하지 않는 fail-safe 설계다.
is_filter_skip() {
  case $filter_skippable_jobs in
    *" $1 "*) ;;
    *) return 1 ;;
  esac
  [ "$gate_event_name" = "pull_request" ] || return 1
  [ "$gate_changes_code" = "false" ] || return 1
  return 0
}

if [ "$#" -ne "$expected_count" ]; then
  echo "ci-gate.sh: exactly 15 job=result arguments required, got $#" >&2
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

  # 중복 금지 — 15개 인자가 중복을 포함하면 어떤 필수 잡이 검사되지 않은 채
  # PASS 로 빠진다(전부 success 여도 계약 위반이다).
  case $seen_jobs in
    *" $job "*)
      echo "ci-gate.sh: duplicate job '$job'" >&2
      exit 2
      ;;
  esac
  seen_jobs="$seen_jobs$job "

  if [ "$result" != "success" ]; then
    if [ "$result" = "skipped" ] && is_filter_skip "$job"; then
      # 경로 필터에 의한 설계된 skip — GitHub 이 필수 체크의 skipped 를 merge
      # 요건 충족으로 보므로 gate 도 통과로 인정한다.
      :
    else
      violations="$violations  fail  $job: $result\n"
    fi
  fi
done

# 누락 금지 — 인자 개수가 15개여도 중복 없이 잡이 빠지는 조합은 없지만, 스크립트
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
  echo "gate: PASS — 모든 필수 잡 success (15/15)"
  for arg in "$@"; do
    job=${arg%%=*}
    result=${arg#*=}
    # PASS 분기에 skipped 가 남아 있다면 is_filter_skip 을 통과한 것뿐이다.
    if [ "$result" = "skipped" ]; then
      echo "  skip $job (경로 필터 — code 무관 변경, docs 전용 PR)"
    else
      echo "  ok   $job"
    fi
  done
  exit 0
fi

echo "gate: FAIL — 필수 잡 중 green이 아닌 잡:" >&2
printf '%b' "$violations" >&2
exit 1
