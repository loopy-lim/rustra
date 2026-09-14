[English](./release-procedure.md)

# 발행 절차 (canary → stable → rollback)

Frame 전환과 감사 수정은 0.10 동시 업그레이드 대상이다. 이미 사용한 0.9.0을
재사용하지 않으며, 대상 버전·소비자 검증·롤백은 [릴리스 준비 문서](migrations/post-0.9-frame-and-audit.ko.md)를 따른다.

감사 항목 8의 "canary 배포와 rollback 검증" 절차. 실제 실행은 별도 승인 후 진행한다.

## 사전 조건 (자동 게이트)

1. 발행 후보의 **정확한 SHA**에 대해 실제 push/PR CI의 최신 실행이 성공해야 한다.
   schedule CI는 일부 job만 실행하므로 발행 근거로 인정하지 않는다.
2. `release.yml`은 npm 자동 경로(`workflow_run: CI success`)와 crates 수동 경로
   (`workflow_dispatch`, main 한정) 모두 후보 SHA를 고정하고 Miri·Sanitizer·Fuzz를
   재사용 workflow로 새로 실행한다. 세 결과가 모두 성공해야 발행 job을 시작한다.
   누락·실패·취소·skip은 차단하며, 발행 직전 CI 상태도 다시 확인한다.
3. 검사 범위: Miri의 lib/frame_wire/field_order_drift, Linux x86_64 ASan+LSan lib,
   Fuzz의 invoke_frame/invoke_complex_value/invoke_complex_serde 각각 seed 재생 및
   600초. 주간 안전성 실행은 별도로 유지하며 PR required check와 구분한다.

Linux x86_64 sanitizer job은 교차 플랫폼 메모리 안전성 게이트다. 호환성
매트릭스의 실제 Tauri WebView·수명주기·패키지 설치 수용 기록을 확보하기 전까지
Linux 지원 수준은 **Alpha**로 유지한다.

독립 안전성 실행 결과를 조회하려면 다음 읽기 전용 감사를 사용한다. 같은 후보의
최신 적격 실행만 인정하며 오래된 성공으로 최신 실패를 덮지 않는다. `GH_TOKEN`은
기존 인증 환경에 제공하고 값을 출력하지 않는다.

```bash
node scripts/check-release-gates.mjs --repository loopy-lim/rustra --sha "$(git rev-parse HEAD)" > release-gates.json
```

Release 내부는 새 안전성 job의 `needs`로 검사 성공을 강제하므로 CI 조회에만
`--ci-only`를 사용한다. 이를 독립 발행용 안전성 우회 옵션으로 사용하지 않는다.
Miri/ASan artifact는 `*-report-<run_id>-<attempt>`에 SHA·도구 버전·stdout/stderr·
종료 코드와 ASan 원본 보고서를 포함한다. 저장 경로는 절대 경로
`$GITHUB_WORKSPACE/target/safety/`이며 결과와 무관하게 업로드한다. Miri의 한 suite가
실패해도 다른 suite는 계속 실행하고 전체 job은 실패한다. 실패를 수정한 새 SHA의
CI를 통과시키고 Release를 재실행한다. 새 실행이 통과하기 전에는 발행하지 않는다.

## 1단계 — changeset 확정

공개 `@rustra/*` 9종은 독립 release line입니다. 변경된 package만 changeset에
올리고, 각 adapter/CLI가 요구하는 `@rustra/types` 호환 범위를 유지합니다. Rust
`rustra`/`rustra-macros` 쌍은 Cargo workspace 안에서 계속 함께 호환되어야 하지만
npm package 버전과 일치할 필요는 없습니다. `@rustra/cli`의 `rustraTemplate`에는
생성할 Rust crate와 RN adapter의 명시적 semver 범위가 들어갑니다.
`bun run test:release-coherence`는 package별 버전, lockfile, 내부 의존성 범위,
CLI의 Rust·RN adapter 범위, LICENSE 및 fixed group을 검사합니다.

두 `rustraTemplate` 범위는 움직이는 시점이 다르고, 둘 다 coherence 검사가
지킵니다. `cargoRange`는 Cargo workspace 버전을 올리는 기능 커밋에서 함께
움직입니다(Rust 라인은 changesets 관리 대상이 아니다). `reactNativeRange`는
버전 PR 안에서(`bun run version` → `scripts/version-packages.mjs`) 새로 올라간
`@rustra/react-native` 버전에 맞춰 동기화됩니다. 같은 스크립트가
`changeset version` 뒤 `bun.lock`도 다시 맞춘다 — 버전만 올리고 lock 이
뒤처지면 version PR 의 `test:release-coherence` 가 실패한다(2026-09-10 첫
버전 PR 실측). `reactNativeRange`를 기능 브랜치에서 adapter 버전보다 먼저
올리면 안 됩니다 — 코드젠의 adapter 버전 게이트가 저장소 안 예제를 거부해서
기능 머지와 버전 PR 사이 main CI 가 깨집니다(같은 날 실측).

소비자에게 breaking DX 변경이 생긴 minor 릴리스는 버전 PR에
`docs/migrations/<from>-to-<to>.md`를 포함하고 README에서 연결합니다. 자동
전환이 불가능한 host 설정, 성능 escape hatch, 롤백 절차를 반드시 적습니다.

```bash
bunx changeset status   # 대상 패키지/범프 확인
```

- `.changeset/*.md` 가 main 에 있으면 release.yml 이 version-packages PR(`chore: version packages`)을 만든다
- PR 머지 시 버전 필드 + CHANGELOG 이 일괄 갱신되고 changeset 파일은 소비된다
- 서로 다른 package가 함께 바뀌어야 할 때만 각 package를 같은 changeset에 명시한다.
  fixed group을 다시 추가해 전체 package를 묶지 않는다.

## 2단계 — canary (사전 검증)

canary 발행도 별도 승인과 후보 안전성 검사가 필요하다. Snapshot 버전 변경은
별도 후보 커밋으로 고정한 뒤 그 SHA에서 위 전체 게이트를 확보한다. 검사 후
manifest를 다시 변경해 이전 SHA의 증거를 재사용하지 않는다.

```bash
bun run build
bunx changeset version --snapshot canary
# 이 변경을 후보로 고정하고 전체 안전성 검사를 통과한 뒤, 승인된 canary 발행만 진행
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
   실제 CI와 새 Miri·Sanitizer·Fuzz 성공을 확인한 뒤 rustra-naming → rustra-macros → rustra 순서로
   각 의존성의 인덱스 반영을 기다리며 발행

안전성 게이트를 거치는 위 수동 workflow를 사용한다. 로컬 `cargo publish`나
`changeset publish`는 GitHub의 의존 job을 실행하지 않으므로 이 절차의 승인된
stable 발행 경로가 아니다. 원본 결과는 Release run과 각 artifact에 보관한다.

## 3.5단계 — main 브랜치 보호 (2026-08-21 적용 완료)

- 필수 체크(required checks): `rust-audit`, `rust (ubuntu-latest)`, `rust (macos-latest)`,
  `rust (windows-latest)`, `typescript`, `rn-android`, `rn-ios`, `consumer-smoke`,
  `rust-wasm32`. 이 문서의 목록 갱신만으로 실제 브랜치 보호가 바뀌지는 않는다 —
  required-checks 등록은 별도이며 아래 `gh api`로 수동 적용한다.
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
        "consumer-smoke",
        "rust-wasm32"
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
node scripts/audit-release-registry.mjs --output /tmp/rustra-release-matrix.json
```

[배포 조합표](release-matrix.ko.md)의 JSON/Markdown을 발행 전후에 보관한다.
정확한 버전·latest·npm gitHead·crate VCS SHA·checksum을 비교한다. 생성물/native
hash는 로컬 artifact 증거이며 레지스트리 설치·실기기 성공과 구분한다. 실제
레지스트리 소비 검증은 해당 버전을 고정한 깨끗한 consumer에서 별도로 수행한다.
