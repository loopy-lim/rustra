# 발행 절차 (canary → stable → rollback)

감사 항목 8의 "canary 배포와 rollback 검증" 절차. 실제 실행은 별도 승인 후 진행한다.

## 사전 조건 (자동 게이트)

1. PR 머지 → main 에서 CI 전 잡 green (rust 3-OS + release 테스트 + rust-audit +
   typescript/test:compat + rn-android + rn-ios + consumer-smoke)
2. `release.yml` 은 `workflow_run: CI success` 로만 트리거된다 (수동 우회 불가)

## 1단계 — changeset 확정

```bash
npx changeset status   # 대상 패키지/범프 확인
```

- `.changeset/*.md` 가 main 에 있으면 release.yml 이 "Version Packages" PR 을 만든다
- PR 머지 시 버전 필드 + CHANGELOG 이 일괄 갱신되고 changeset 파일은 소비된다

## 2단계 — canary (사전 검증)

```bash
npm run build
npx changeset version --snapshot canary
npx changeset publish --tag canary
```

소비자 검증:

```bash
mkdir /tmp/canary-check && cd /tmp/canary-check && npm init -y
npm install @rustra/node@canary @rustra/types@canary
node --input-type=module -e "import * as n from '@rustra/node'; console.log(Object.keys(n))"
```

crates.io canary 는 지원하지 않는다 (버전 삭제 불가) — Rust 는 stable 만 발행한다.

## 3단계 — stable 발행

1. Version Packages PR 머지 → release.yml 자동 실행 (npm 10종)
2. crates 수동 잡: Actions → Release → cargo-publish 는 `workflow_dispatch` 전용이므로
   **이 문서의 예외 경로**로만 실행 (rustra-macros → 30s 대기 → rustra 순서)

```bash
# 로컬 검증 후 수동 발행 (crates 는 되돌릴 수 없어 2단 게이트)
cargo publish -p rustra-macros --dry-run --allow-dirty
cargo publish -p rustra-macros
sleep 30
cargo publish -p rustra
```

## 4단계 — rollback

- **npm**: `npm dist-tag add @rustra/node@0.1.2 latest` — dist-tag 되돌리기로 즉시
  rollback (패키지 자체는 삭제하지 않는다). 전 패키지 동일 적용.
- **crates.io**: 불가 (버전 영구). `cargo update --precise 0.1.2` 를 사용자 안내로 대체.
- **깃**: 버전 커밋 revert → 재발행은 0.1.x → 0.1.(x+1) 로만 가능 (같은 버전 재발행 불가).

## 발행 후 확인

```bash
npm view @rustra/node versions --json | tail -5
cargo search rustra --limit 3
```
