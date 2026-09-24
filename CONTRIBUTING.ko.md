# 기여 가이드

rustra에 기여하는 방법을 정리한다.

---

## 개발 환경 설정

### 요구사항

사용자용 전제 조건은 [시작하기](docs/getting-started.ko.md#전제-조건)의 표가 단일
원천이다(Rust 1.88+ MSRV, Bun 1.4+, Node.js 22.x, 호스트별 네이티브 툴체인).
여기에는 저장소 개발 관련 사항만 덧붙인다:

- Rust 1.88+ — workspace MSRV(루트 `Cargo.toml`의 `rust-version`, edition 2024,
  resolver 3)
- Bun 1.4.0 — 루트 `package.json`의 `packageManager` 필드가 고정하고 CI가
  설치하는 정확한 버전
- Node.js — 배포 패키지는 최소 지원 런타임으로 `engines.node >= 18`을 선언하지만,
  CI는 Node 22를 사용한다(`.github/workflows/ci.yml`의 `setup-node`). CI와
  맞추려면 로컬에서도 22.x를 사용한다

### 로컬 게이트의 시스템 사전조건

일상 우산 — `test:fast`, `test`, `test:compat`, `test:local` — 는 추가 시스템
라이브러리 없이 모든 플랫폼(Linux 포함)에서 돈다. Rust 단계가
`rustra-tauri-calculator` 크레이트를 제외하기 때문이며, 그 Tauri/WebKit
의존성이 문제가 되는 것은 아래 명령들뿐이다:

- `cargo build/test --workspace`(전체 워크스페이스)와 `bun run
test:runtime:tauri`는 Tauri 예제를 빌드하므로 시스템 라이브러리가 필요하다:
  - **Linux**: `sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev
libappindicator3-dev librsvg2-dev patchelf libsoup-3.0-dev
libjavascriptcoregtk-4.1-dev` — CI `rust`/`ts-runtime` 잡이 설치하는 것과
    동일 목록
  - **macOS**: Xcode Command Line Tools(WebKit은 OS SDK에 포함)
  - `test:runtime:tauri`는 예제 자체 의존성도 필요하다:
    `bun install --cwd examples/tauri-calculator`
- `bun run test:adapters`는 모킹 transport를 쓰므로(Tauri 라이브러리 불필요)
  되지만, `test:app:react-native` 구간이
  `examples/react-native-calculator`를 타입체크하며 여기엔 별도
  node_modules가 필요하다: `bun install --cwd examples/react-native-calculator`

CI는 Tauri 런타임 구간(`test:runtime:tauri`)을 모든 PR에서 실행한다
(`ts-runtime` 잡, 위 라이브러리가 설치된 Ubuntu). 따라서 Linux 기여자는
그 구간을 CI에 맡기면 된다 — PR 필수 `test:compat` 체인에는 더 이상
포함되지 않는다.

### 초기 설정

```bash
git clone <repo-url> && cd rustra-bridge
bun install                 # 워크스페이스 의존성

bun run test:fast           # 웜 기준 약 15초의 첫 신호(첫 실행은 더 김): cargo check + calculator tsc + cli 유닛 테스트
                            # Linux-safe — Tauri 시스템 라이브러리 불필요

# 전체 배터리(느림)
cargo build --workspace     # Tauri 예제도 빌드 — 위 "시스템 사전조건" 참조
cargo test --workspace
bun run test:local          # 로컬에서 돌릴 수 있는 CI 배터리; 전체 게이트 지도는 docs/gate-map.md
```

---

## 프로젝트 구조 이해

기여 전에 다음 문서를 읽는 것을 권장한다:

1. [아키텍처 개요](docs/architecture.md) — 전체 구조와 핵심 개념
2. [Crate 및 Package 구조](docs/internal/crate-structure.md) — 각 crate/package의 책임과 의존성
3. [테스트 구조](docs/internal/testing.md) — 테스트 계층, 실행 명령어

---

## 개발 워크플로우

### 1. 브랜치 생성

```
main → feature/짧은-설명
     → fix/짧은-설명
```

### 2. 코드 변경

Rust 코드를 변경하면:

```bash
# Rust 테스트
cargo test --workspace

# 생성된 TS 갱신 (calculator 예시)
cargo run -p rustra-calculator-example --bin generate   # 계약 프로브: schema.json
bun run --cwd examples/calculator codegen                # TS 표면 렌더링

# 빠른 개발 루프: cargo check + calculator tsc + cli 유닛 테스트
bun run test:fast

# 전체 호환성 테스트
bun run test:compat
```

TypeScript 패키지를 변경하면:

```bash
# 어댑터 테스트
bun run test:adapters

# 런타임 테스트
bun run test:runtime
```

### 3. 커밋

커밋 메시지는 변경의 **이유**를 중심으로 작성한다:

```
feat: add tuple type support in TS codegen

fix: handle null args in rustra_dispatch

docs: add debugging guide to contributing

refactor: extract command name resolution into shared function
```

### 4. PR 생성

- PR 제목은 70자 이내로 변경을 요약
- PR 본문에 **무엇을** 변경했는지, **왜** 필요한지 설명
- `bun run test:compat`가 통과하는지 확인 — Linux-safe 통합 체인
  (`test:ts:node` + `test:ts:bun` + `test:adapters` + `test:runtime:node` +
  `test:runtime:bun`)
- "로컬에서 뭘 돌려야 CI가 green인가"의 전체 그림은
  [게이트 지도](docs/gate-map.md) 참조. `bun run test:local`이 로컬 가능한
  배터리 전부를, Rust 게이트는 `cargo fmt/clippy/test`가 담당한다

---

## 테스트

### 테스트 계층

3개 우산 계층과 PR 필수 통합 체인 — 각 스크립트의 비용·CI 잡 매핑은
[게이트 지도](docs/gate-map.md)가 정리한다:

```
bun run test:fast    ← 계층 1 · 빠른 신호(웜 ~15초): cargo check + calculator tsc + cli 유닛
    ↓                   (lefthook pre-push 훅이기도 하다)
bun run test         ← 계층 2 · 패키지 유닛: types + packages + cli 스위트 + ts:bun + bench-gate 유닛 + functions
    ↓
bun run test:local   ← 계층 3 · 전체 로컬 배터리: CI TS 잡의 로컬 실행 가능한 전부
    ↓
bun run test:compat  ← PR 필수 통합 체인(Linux-safe): ts:node + ts:bun + adapters + runtime node/bun
```

`test:runtime:tauri`(실제 Tauri 앱 빌드 + 스모크)는 의도적으로
`test:compat`에 포함하지 않았다 — Tauri 시스템 라이브러리 없는 Linux에서도
PR 게이트가 통과해야 하기 때문이다. CI `ts-runtime` 잡이 모든 PR에서
실행하며, 로컬 실행은 위 [시스템 사전조건](#로컬-게이트의-시스템-사전조건)이
필요하다.

`test:local` 안의 온보딩 게이트는 공유 cargo 타깃 캐시에 옵트인한다
(`test:onboarding:check` 구간에
`RUSTRA_ONBOARDING_CARGO_TARGET_DIR=target/onboarding-shared` 주입) — 반복
실행 시 콜드 스캐폴드 빌드를 건너뛴다. 변수 없이 `node scripts/onboarding-gate.mjs`
를 직접 실행하면 기존대로 콜드(신선한 스캐폴드) 검증이 유지된다.

### 어떤 게이트를 언제

| 명령                               | 실행 시점                                        | 검사 내용                                                               |
| ---------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------- |
| `bun run test:fast`                | 로컬 편집 루프마다 (pre-push에서 자동 실행)      | cargo check + calculator tsc + cli 유닛 테스트 (Linux-safe)             |
| `bun run test:local`               | PR 전, 로컬 CI 배터리 전체를 돌고 싶을 때        | CI TS 스텝의 로컬 실행 가능 분량을 한 체인으로 (느림; release 빌드 2회) |
| `bun run test:docs`                | docs/ 또는 docs:sync 리전 수정 시                | en/ko 미러, 동기화 리전, 설치 문서-매니페스트 정합                      |
| `bun run test:codegen-fresh`       | 스키마·제너레이터·`examples/*/generated` 수정 시 | 커밋된 생성물이 현재 소스에서 재현되는지                                |
| `bun run test:api-surface`         | 공개 TS/Rust 표면 변경 시                        | `api-surface/snapshot.json` 대비 diff(의도 수용은 `--update`)           |
| `bun run test:architecture`        | 모듈 경계 수정 시                                | 파일 크기·모듈 경계 상한                                                |
| `bun run test:release-coherence`   | 버전·범위·락파일 수정 시                         | 패키지/락파일/범위 불변식                                               |
| `bun run test:release-tools`       | scripts/ 또는 릴리스 흐름 수정 시                | 릴리스 도구 유닛 테스트                                                 |
| `bun run test:functions`           | 일반 함수 등록 수정 시                           | 함수 등록 엔드투엔드 통합                                               |
| `bun run test:registry-consumer`   | 호스트 핀·소비자 설치 경로 수정 시               | 레지스트리 소비자 설치 게이트                                           |
| `bun run test:complex-codec-bench` | complex codec 수정 시                            | codec receipt 회귀                                                      |

### Rust 테스트

```bash
cargo test --workspace
```

### TypeScript 테스트

```bash
# 전체 (PR 필수, Linux-safe)
bun run test:compat

# 개별
bun run test:ts:node
bun run test:ts:bun
bun run test:adapters
bun run test:runtime:node
bun run test:runtime:bun
bun run test:runtime:tauri   # 위 Tauri 시스템 사전조건 필요
```

### 테스트 파일 위치

| 파일                                                | 역할                        |
| --------------------------------------------------- | --------------------------- |
| `crates/rustra/tests/public_authoring_api_tests.rs` | Rust 공개 API 테스트 (48개) |
| `examples/calculator/tests/example_contract.rs`     | 종단 간 계약 테스트 (1개)   |
| `examples/calculator/ts/generated-client.test.ts`   | TS 클라이언트 동작 (2개)    |
| `examples/calculator/ts/adapter-compat.test.ts`     | 4개 어댑터 호환성 (5개)     |
| `examples/calculator/ts/runtime-contract.test.ts`   | 런타임 계약 (2개)           |

### 문서 동기화 게이트

생성 코드를 인용하는 문서는 `docs:sync` 마커로 감싸야 한다. `bun run test:docs`가
인용 본문과 실제 파일을 byte-for-byte로 대조한다:

````markdown
<!-- docs:sync:begin <저장소 상대 경로> -->

<!-- prettier-ignore -->
```ts
(인용한 파일 본문 — 생성물의 자기서술 헤더는 자동 제외)
```

<!-- docs:sync:end -->
````

- 배치 규약: `begin` 다음 빈 줄 하나, 그 다음 `<!-- prettier-ignore -->`와 바로
  이어지는 여는 펜스. 닫는 펜스 뒤에는 빈 줄 하나를 두고 `docs:sync:end`. 구조
  위반은 게이트가 실패로 보고한다.
- 스캔 범위는 `docs/`뿐(`docs/plans/` 제외)이므로 이 규약을 `CONTRIBUTING.ko.md`
  에 인용해도 오탐이 없다.
- 게이트는 **en/ko 미러 완전성**도 강제한다 — 스코프 내 모든 `X.md`에는 `X.ko.md`
  쌍이(그 반대도) 있어야 한다. 같은 PR에서 양쪽을 함께 편집한다.
- 로컬 실행: `bun run test:docs`.

---

## 코드 규칙

### 불변식

모든 변경은 [호환성 계약](docs/compatibility-contract.md)을 만족해야 한다:

1. **생성된 TS는 host-specific import를 포함하지 않는다**: `node:`, `bun:`, `@tauri-apps`, `react-native`, `expo-modules` 금지
2. **어댑터 패키지는 서로를 import하지 않는다**
3. **어댑터는 host 패키지를 직접 import하지 않는다**: transport는 호출자가 주입
4. **`EngineClient`가 유일한 계약이다**: command helper는 `EngineClient`만 의존

### Rust

- 공개 API는 `prelude` 모듈에서 재export
- `#[command]` 매크로는 시그니처 검증 + trait bound assertion만 수행 (본문은 identity passthrough)
- 에러는 `RustraError`로 통일

### TypeScript

- 어댑터 패키지는 외부 의존성 없이 순수 TypeScript
- `EngineClient` 인터페이스(`invoke<T>`)만 노출
- Tauri만 `rustra_dispatch` 래핑, 나머지는 transport 직접 호출

---

## 디버깅 가이드

### 코드 생성 결과가 이상할 때

1. `schema.json` 확인 — schemars가 생성한 JSON Schema가 의도한 대로인지 검사
2. `types.ts` 확인 — JSON Schema → TS 타입 매핑 규칙은 [codegen 문서](docs/internal/codegen.md) 참조
3. rustra가 생성하지 않는 조건부 JSON Schema는 `unknown`, postcard가 와이어
   순서를 증명할 수 없는 data enum/중첩 collection은 명령 단위 Tier 3로 폴백됨

### Contract hash 불일치

`contract.ts`의 `GENERATED_CONTRACT_HASH`는 `schema.json`의 SHA-256 해시다. Rust 코드를 변경하고 TS를 재생성하지 않으면 해시가 달라진다:

```bash
# 재생성
cargo run -p rustra-calculator-example --bin generate   # 계약 프로브: schema.json
bun run --cwd examples/calculator codegen                # TS 표면 렌더링

# diff로 확인
git diff examples/calculator/generated/contract.ts
```

### command 이름이 예상과 다를 때

- `command_fn()`은 `std::any::type_name`에서 이름을 추출한다. 디버그 빌드에서는 전체 경로가 포함될 수 있음
- 정확한 이름이 필요하면 `#[command(name = "myCommand")]` 사용
- `commands.ts`에서 실제 생성된 이름을 확인

### 어댑터 테스트 실패

```bash
# 특정 어댑터만 실행
bun run test:adapter:tauri
bun run test:adapter:react-native

# 모킹 transport로 로깅
const engine = createNodeEngine({
  invoke(command, args) {
    console.log('invoke:', command, args);
    return mockResponse;
  },
});
```

### Tauri 런타임 디버깅

Tauri 앱이 `rustra_dispatch`에서 에러를 반환할 때:

1. Rust 측: `RustraError`가 `{ code, message }` JSON으로 직렬화됨
2. TS 측: `createTauriEngine`이 이를 `RustraCommandError`로 변환하여 throw
3. 콘솔에서 `e.code`, `e.message` 확인

### React Native 관련

- RN 런타임 smoke은 CI에 **포함되어 있다**: `rn-android`/`rn-ios` 잡이 Release
  APK/app을 빌드하고 에뮬레이터/시뮬레이터를 부팅해 설치한 뒤 통합 로그에서 앱이
  계산한 결과를 단언한다(`scripts/ci-android-runtime-smoke.sh`,
  `scripts/ci-ios-runtime-smoke.sh`). `uniffi-android`/`uniffi-ios` 잡은
  UniFFI 바인딩(`examples/uniffi-*-smoke`)에 대해 같은 작업을 한다
- `test:adapter:react-native`는 모킹 transport로 검증 (실제 FFI 아님)
- FFI 문제 시 Swift 모듈에서 `@_silgen_name` 함수명과 Rust `#[unsafe(no_mangle)]` 함수명이 일치하는지 확인

---

## 릴리즈

### 커밋 훅 (lefthook)

`bun install`이 `prepare` 스크립트로 lefthook을 설치한다. pre-commit에서
스테이지된 파일만 자동 포맷한다:

- `packages/*/src/**`, `scripts/**`, `examples/**` TS 파일(생성 코드와 자체
  툴체인을 가진 RN/napi 예제 제외) → `eslint --fix`
- `*.{ts,js,json,yml,md}` → `prettier --write`
- `*.rs` → `rustfmt`

세 명령 모두 `stage_fixed: true`로 실행되므로, 포맷 수정은 자동으로
재스테이징되어 같은 커밋에 포함된다. 훅이 파일을 수정했다고(lefthook이
보고하면) 커밋을 다시 시도하면 끝이다 — 예전의
`git add -A && git commit --amend --no-edit` 의식은 더 이상 필요 없다.

**pre-push** 훅은 push가 로컬을 떠나기 전에 `bun run test:fast`(cargo check +
calculator tsc + cli 유닛 테스트)를 추가로 실행한다. 컴파일·유닛 실패가
CI 대기열을 거친 수 분 뒤가 아니라 수 초 안에 드러난다. 같은 명령이 CI
`ts-checks` 잡 선두에서 스모크로 돌아가 우산 드리프트를 막는다.

### 버전 관리 (changesets)

- 현재 버전은 Rust workspace의 `Cargo.toml`과 각 `packages/*/package.json`을
  기준으로 확인한다. 공개 `@rustra/*` 패키지들은 **독립 release line**이므로
  모두 같은 버전일 것을 가정하지 않는다.
- `0.x` 동안 breaking change가 가능하므로, 공개 API 변경은 반드시 changeset에
  영향받는 패키지와 bump 종류를 명시한다:

```bash
bun run changeset          # 대화형 changeset 작성
bunx changeset status      # 대기 중 changeset/범프 확인
```

- `.changeset/*.md`가 main에 머지되면 changesets action이 **Version Packages
  PR**을 만들고(이미 있으면 갱신) 머지 시 버전 필드 + CHANGELOG을 일괄 갱신한다.
- 작업 중인 소스에서 임의로 버전을 올리거나 tag/push하지 않는다. 버전 업은
  Version Packages PR을 통해서만 일어난다.
- npm 발행은 `release.yml`이 자동으로 하고, crates.io 발행 잡은 수동 승인
  후 실행된다. 전체 절차는 [릴리즈 절차](docs/release-procedure.md) 참조.

### 릴리즈 체크리스트

1. `cargo test --workspace` 통과
2. `bun run test:compat` 통과
3. `bun run test:release-coherence`와 `bunx changeset status` 통과
4. Version Packages PR에서 changeset 소비 및 CHANGELOG 갱신 확인
5. 승인된 릴리즈 절차에 따라 tag/push
