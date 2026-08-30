# 발행 절차 (canary → stable → rollback)

감사 항목 8의 "canary 배포와 rollback 검증" 절차. 실제 실행은 별도 승인 후 진행한다.

## 사전 조건 (자동 게이트)

1. PR 머지 → main 에서 CI 전 잡 green (rust 3-OS + release 테스트 + rust-audit +
   typescript/test:compat + rn-android + rn-ios + consumer-smoke)
2. `release.yml` 은 `workflow_run: CI success` 로만 트리거된다 (수동 우회 불가)

## 1단계 — changeset 확정

공개 `@rustra/*` 9종은 독립 release line입니다. 변경된 package만 changeset에
올리고, 각 adapter/CLI가 요구하는 `@rustra/types` 호환 범위를 유지합니다. Rust
`rustra`/`rustra-macros` 쌍은 Cargo workspace 안에서 계속 함께 호환되어야 하지만
npm package 버전과 일치할 필요는 없습니다. `@rustra/cli`의 `rustraTemplate`에는
생성할 Rust crate와 RN adapter의 명시적 semver 범위가 들어갑니다.
`bun run test:release-coherence`는 package별 버전, lockfile, 내부 의존성 범위,
CLI의 Rust 범위, LICENSE 및 fixed group을 검사합니다.

소비자에게 breaking DX 변경이 생긴 minor 릴리스는 버전 PR에
`docs/migrations/<from>-to-<to>.md`를 포함하고 README에서 연결합니다. 자동
전환이 불가능한 host 설정, 성능 escape hatch, 롤백 절차를 반드시 적습니다.

```bash
bunx changeset status   # 대상 패키지/범프 확인
```

- `.changeset/*.md` 가 main 에 있으면 release.yml 이 "Version Packages" PR 을 만든다
- PR 머지 시 버전 필드 + CHANGELOG 이 일괄 갱신되고 changeset 파일은 소비된다
- 서로 다른 package가 함께 바뀌어야 할 때만 각 package를 같은 changeset에 명시한다.
  fixed group을 다시 추가해 전체 package를 묶지 않는다.

## 2단계 — canary (사전 검증)

```bash
bun run build
bunx changeset version --snapshot canary
bunx changeset publish --tag canary
```

소비자 검증:

```bash
mkdir /tmp/canary-check && cd /tmp/canary-check && bun init -y
bun add @rustra/node@canary @rustra/types@canary
bun -e "import * as n from '@rustra/node'; console.log(Object.keys(n))"
```

React Native adapter는 publish tarball의 native 파일과 clean consumer의 native root
해석을 모두 확인한다.

```bash
bun run verify:package:react-native
bun run verify:consumer:react-native
```

crates.io canary 는 지원하지 않는다 (버전 삭제 불가) — Rust 는 stable 만 발행한다.

## 3단계 — stable 발행

1. Version Packages PR 머지 → release.yml 자동 실행 (npm 9종)
2. crates 수동 잡: Actions → Release → Run workflow는 `main`의 동일 SHA에 대해
   CI 성공을 다시 확인한 뒤 rustra-naming → rustra-macros → rustra 순서로
   각 의존성의 인덱스 반영을 기다리며 발행

```bash
# 로컬 검증 후 수동 발행 (crates 는 되돌릴 수 없어 의존성 순서 게이트)
cargo publish -p rustra-naming --dry-run --allow-dirty
cargo publish -p rustra-naming
sleep 30
cargo publish -p rustra-macros --dry-run --allow-dirty
cargo publish -p rustra-macros
sleep 30
cargo publish -p rustra
```

## 3.5단계 — main 브랜치 보호 (2026-08-21 적용 완료)

- 필수 체크(required checks): `rust-audit`, `rust (ubuntu-latest)`, `rust (macos-latest)`,
  `rust (windows-latest)`, `typescript`, `rn-android`, `rn-ios`, `consumer-smoke`.
- 직접 push는 허용(1인 프로젝트 효율), force push/삭제는 차단.
- 새 CI 잡을 추가할 때 required 목록에도 함께 넣는다 — 목록은 아래 API로 확인/변경:
  ```bash
  gh api repos/loopy-lim/rustra/branches/main/protection
  gh api -X PUT repos/loopy-lim/rustra/branches/main/protection --input - <<'EOF'
  {
    "required_status_checks": {
      "strict": false,
      "contexts": [
        "rust-audit",
        "rust (ubuntu-latest)",
        "rust (macos-latest)",
        "rust (windows-latest)",
        "typescript",
        "rn-android",
        "rn-ios",
        "consumer-smoke"
      ]
    },
    "enforce_admins": false,
    "required_pull_request_reviews": null,
    "restrictions": null,
    "allow_force_pushes": false,
    "allow_deletions": false
  }
  EOF
  ```

## 4단계 — rollback

- **npm registry**: Bun에는 dist-tag 변경 명령이 없으므로 이 관리 작업만
  `bunx --bun npm dist-tag add @rustra/node@<previous> latest`로 실행한다 — dist-tag 되돌리기로 즉시
  rollback (패키지 자체는 삭제하지 않는다). 전 패키지 동일 적용.
- **crates.io**: 불가 (버전 영구). `cargo update --precise <previous>`를 사용자 안내로 대체.
- **깃**: 버전 커밋 revert 후 반드시 다음 patch 버전으로 재발행한다(같은 버전 재발행 불가).

## 발행 후 확인

```bash
bun info @rustra/node | tail -20
cargo search rustra --limit 3
```
