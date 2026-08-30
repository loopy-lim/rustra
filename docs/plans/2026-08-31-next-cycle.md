# Next Cycle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Phase 0(현장 랜딩+0.5.0) 이후 — 안정화 트랙(API 표면 고정·semver 정책·계약 보증 게이트·다중 타깃 매트릭스), 무중단 핸들러 주입(RN wasm3 우선), 인스펙터(덤프 API·inspect CLI·타임라인 리포트·계약 diff 진단)를 구현한다.

**Architecture:** Phase 1은 단일 브랜치에서 게이트(스냅샷·정책·역호환)를 먼저 착지시키고, Phase 2는 병렬 워크트리 2트랙(무중단/인스펙터)으로 구동한다. 새 FFI·TS 표면은 Phase 1 정책 위에 설계된다. rustra.json에 `dev`/`inspector` 섹션을 신설해 관리 허브로 삼고, JSON Schema 발행으로 작성 UX를 제공한다.

**Tech Stack:** Rust workspace (cargo test/clippy), TypeScript NodeNext (Bun test), wasm32-unknown-unknown + wasm3, Node CLI, GitHub Actions.

**Spec:** `docs/plans/2026-08-31-next-cycle-design.md`

---

## Global Constraints

- public import path, generated wire bytes, 계약 해시 알고리즘은 유지한다.
- `RendererHost`는 deprecated/doc-hidden 정책 유지 (삭제 금지).
- adapter 간 직접 의존 금지; RN은 staticlib 기본 경로 유지 (wasm은 debug/dev 한정).
- crates.io 발행은 수동 전용 — 이 계획 어디서도 publish하지 않는다.
- 각 태스크는 failing test 먼저, focused test 통과, 즉시 커밋.
- wasm3 스파이크(A0)는 판정 전까지 후속 태스크 착수 금지 (합격 기준: 실기기에서
  앱 재시작 없이 백엔드 로직 교체 후 동일 command 응답이 native와 바이트 동일;
  불충족 시 Track A wasm 라인은 종료하고 문서화+목업 대체로 회귀).

---

## Phase 1: 안정화 트랙 (브랜치 `stabilization/next-cycle`)

### Task 1: API 표면 스냅샷 스크립트 + 게이트

**Files:**

- Create: `scripts/api-surface.mjs` (수집기 + 스냅샷 생성/비교)
- Create: `scripts/api-surface.test.ts`
- Modify: `package.json` (scripts: `test:api-surface`)
- Create: `api-surface/` 디렉토리에 스냅샷 (스크립트가 생성, 커밋)

**Step 1: 스냅샷 형식 정의와 수집기 구현**

`scripts/api-surface.mjs`:

```js
// 수집 대상:
// 1. Rust: crates/rustra/src/lib.rs의 pub mod/pub use 목록
//    (정규식: /^\s*pub (?:mod|use)\s+.../gm) + ffi*.rs의
//    pub unsafe extern "C" fn rustra_* 이름 목록
// 2. TS: packages/*/src/index.ts의 export 문
//    (정규식으로 export 목록 추출, dist/*.d.ts 재수집 아님 — src 기준)
// 출력: JSON { rustModules, ffiExports, tsExports: { "packages/types": [...] } }
// 정렬 필수 — diff 노이즈 방지
export async function collectSurface(root) { ... }
export async function compareSurface(root) {
  // 스냅샷 부재 시: 생성 후 exit 0 + "snapshot created" 안내
  // 존재 시: diff -> { added, removed } -> added/removed 있으면 exit 1
}
```

**Step 2: 실패 테스트 작성**

`scripts/api-surface.test.ts`: 고정 fixture 디렉토리(임시 lib.rs/index.ts 조각)로
collectSurface가 예상 export를 뽑는지, compareSurface가 추가/삭제 감지하는지 검증.

Run: `bun test scripts/api-surface.test.ts`
Expected: FAIL (모듈 부재)

**Step 3: 수집기 구현 → 테스트 green**

**Step 4: 현재 표면 스냅샷 생성 + package.json 연결**

```bash
node scripts/api-surface.mjs --update   # 스냅샷 생성
# package.json scripts에 추가:
# "test:api-surface": "node scripts/api-surface.mjs"
```

**Step 5: 게이트 확인**

Run: `node scripts/api-surface.mjs && echo PASS`
Expected: PASS (드리프트 없음). 임의로 lib.rs에 pub fn 추가 후 재실행 → FAIL 확인 →
revert.

**Step 6: Commit**

```bash
git add scripts/api-surface.mjs scripts/api-surface.test.ts api-surface/ package.json
git commit -m "feat(stability): API 표면 스냅샷 게이트 추가"
```

### Task 2: 의도적 노출 태깅 정리

**Files:**

- Modify: `crates/rustra/src/lib.rs` (필요시 `#[doc(hidden)]` 보강)
- Modify: `packages/types/src/index.ts` 등 (필요시 `@internal` JSDoc)

**Step 1: 스냅샷 목록을 사람이 검토** — 내부용이지만 pub인 항목에
`#[doc(hidden)]`/`@internal` 태그. 태그만 추가하고 export는 이동/삭제하지 않는다
(하위호환). 스냅샷은 태그 무관 export 목록이므로 불변.

**Step 2: 전체 빌드·테스트로 회귀 없음 확인**

Run: `cargo clippy --all-targets -- -D warnings && bun run test:types`
Expected: green

**Step 3: Commit** — `docs(stability): 내부 표면 doc(hidden)/@internal 태깅`

### Task 3: versioning-policy.md

**Files:**

- Create: `docs/versioning-policy.md` + `docs/versioning-policy.ko.md`

**Step 1: 정책 문서 작성** — 설계 문서 §Phase 1-2 내용 그대로:
호환 보증 대상(wire 포맷·계약 해시·FFI 시그니처·generated output), 폐기 절차
(deprecated → 최소 1 minor → 제거), experimental 태그 규칙
(`rustra_ffi_hot_reload` 등), MSRV(Rust 1.88) 정책.

**Step 2: 링크 정합** — README Roadmap 및 docs/README에 링크 1줄 추가.
Run: `bun run lint:links 2>/dev/null || ls docs/versioning-policy.md` (링크 검사
스크립트가 있으면 실행)

**Step 3: Commit** — `docs(stability): versioning-policy 문서 신설`

### Task 4: 역호환 golden fixture 게이트

**Files:**

- Create: `packages/types/src/backcompat.test.ts` (또는 기존 golden 테스트 파일 확장)

**Step 1: 0.4.x 시절 wire fixture 확보** — 기존 PINNED hex 테스트에서 golden 케이스
추출 (구 버전 산출물 재현이 어려우면 현재 PINNED hex를 fixture로 복사).
complex-codec 테스트의 PINNED hex들이 이미 역방향 고정 역할임을 확인하고,
부족하면 구 스키마 fixture JSON(`api-surface/` 옆 `fixtures/wire-v0_4/`) 추가.

**Step 2: 테스트 작성** — "구 fixture → 신 코덱 decode == 기대값" 스위트 + 각 타깃 행
(로컬 native) 실행.

Run: `bun test packages/types/src/backcompat.test.ts`
Expected: PASS (PINNED hex는 이미 green이므로 fixture 추가분이 FAIL 나면 코덱 회귀)

**Step 3: CI 연결** — `.github/workflows/ci.yml`의 types 테스트 단계에 포함되는지 확인
(packages/types test는 이미 CI가 돌림 — 신규 워크플로 불필요하면 그대로).

**Step 4: Commit** — `test(stability): 0.4.x wire 역호환 golden fixture 게이트`

### Task 5: doctor 다중 타깃 매트릭스

**Files:**

- Modify: `packages/cli/src/doctor-checks.ts`, `doctor-report.ts`, `doctor-format.ts`
- Test: `packages/cli/src/doctor.test.ts`

**Step 1: 실패 테스트** — `rustra.json`에 node+bun+reactNative 섹션 동시 존재 fixture
→ doctor가 **세 섹션 모두** 검사 결과를 표로 수집. exit code는 최악 상태.
한 섹션 red(예: bun rustLibrary 경로 부재)여도 다른 섹션 검사 계속.

**Step 2: 구현** — 기존 doctor-checks의 host-conditional 구조를 섹션 루프로 확장.
출력 형태:

```
  target        build   contract   runtime     notes
  node          OK      OK         OK          —
  bun           OK      —          FAIL        rustLibrary missing: ./target/...
  reactNative   OK      OK         WARN        iOS physical-device evidence pending
```

**Step 3: 교차 일관성 검사 추가** — 섹션들이 가리키는 rustManifest/rustPackage가
서로 다르면 경고 1줄 ("multiple Rust backends referenced — one project, one contract").
테스트에 케이스 추가.

Run: `bun run --cwd packages/cli test -- grep doctor` (실제 명령은 `bun test packages/cli/src/doctor.test.ts`)
Expected: PASS

**Step 4: Commit** — `feat(cli): doctor 다중 타깃 매트릭스 + 교차 일관성 검사`

### Task 6: rustra.json — dev/inspector 섹션 + 검증 사다리

**Files:**

- Modify: `packages/cli/src/config.ts`
- Modify: `packages/cli/src/generate.test.ts` (config 케이스 상당수 기존 위치) 또는
  Create: `packages/cli/src/config-validation.test.ts`
- Create: `packages/cli/rustra.schema.json` (또는 packages/types — 발행 위치는
  npm files 필드와 정합)
- Modify: `packages/cli/package.json` (files에 schema 포함)

**Step 1: 실패 테스트 (상황 매트릭스 전수)**

| 상황                                           | 기대                                             |
| ---------------------------------------------- | ------------------------------------------------ |
| `dev.target: "wasm"` + reactNative 섹션 부재   | L2 에러: "wasm dev requires reactNative section" |
| `dev.target: "wasm"` + `wasm.engine: "wasmer"` | L2 에러: 허용값 "wasm3"만                        |
| `dev.wasm.parityGate` + `target: "native"`     | L2 에러: parityGate는 wasm에서만                 |
| `inspector.onMismatch: "diagnose"`             | 수용 (devtools 미탑재는 doctor 경고 — L2 아님)   |
| `inspector.onMismatch: "hoge"`                 | L1 에러 + did-you-mean                           |
| 구형 config (신규 섹션 없음)                   | 수용 — 기존과 동일                               |
| 오타 키 `dev.targt`                            | L1 fail-closed (기존 assertKnownKeys)            |
| L2 위반 복수                                   | **모두 수집해 나열** (첫 위반에서 중단 않음)     |
| `dev.target: "native"` + wasm 섹션             | L2 에러 (wasm 섹션은 wasm 타깃에서만)            |

**Step 2: config.ts 확장** — `RustraConfig`에 dev/inspector 타입 + L1 검증 확장 +
L2 `collectSemanticErrors(config)` 신설 (배열 반환, 로드 시 있으면 전부 나열 후 throw).

**Step 3: schema 발행** — `rustra.schema.json` 수동 작성 (JSON Schema draft-07).
스키마↔타입 동기화 게이트는 Task 6 범위에서 수동 대조 테스트 1개
(필드 목록 대조)로 충분 — 전용 코드젠은 YAGNI.

**Step 4: focused test green → Commit** — `feat(cli): rustra.json dev/inspector 섹션 + L2 의미 검증`

### Task 7: rustra init — $schema 삽입 + 호스트 감지 최소 템플릿

**Files:**

- Modify: `packages/cli/src/cli-init.ts`, `init-template.ts`

**Step 1: 실패 테스트** — init 산출 config에 `"$schema"` 키 존재; node-only 프로젝트
감지 시 node 섹션만; `--host react-native` 명시 시 RN 섹션 포함; 기존 config 존재 시
"already exists" 안내 유지.

**Step 2: 구현 → green**

**Step 3: Commit** — `feat(cli): init이 $schema 삽입 + 감지 기반 최소 config 생성`

### Task 8: wasm32 CI 매트릭스 행

**Files:**

- Modify: `.github/workflows/ci.yml`

**Step 1: 로컬 선행 검증**

```bash
rustup target add wasm32-unknown-unknown
cargo check -p rustra --target wasm32-unknown-unknown
```

실패 시: worker pool/fs 의존 분석 → `#[cfg(target_arch = "wasm32")]` 축소 구현이
필요한지 판정. **컴파일만 목표** (테스트 실행은 아님 — 아키텍처 한계). 예상 소요
큼 → 이 태스크에서 컴파일 불통이 확정되면 스파이크 A0 전에 이슈로 분리해 보고,
CI 행은 skip-if-unavailable로 남김.

**Step 2: CI에 wasm32 check job 추가** (続失敗 시 job은 유지하되 `continue-on-error:
true` + 주석으로 사유 — "게이트 파손은 내 diff 여부와 무관하게 먼저 확인" 교훈 반영:
red base에서 시작하지 않는다).

**Step 3: Commit** — `ci: wasm32 타깃 컴파일 check 행 추가 (parity 게이트 전초)

### Task 9: examples 전수 점검 + 마이그레이션 보완

**Step 1:** `bun run test:compat` 전체 실행 — 실패 시 수정.
**Step 2:** docs/migration-guide에 0.5.0 섹션 점검/보완.
**Step 3: Commit** — `test(stability): examples 전수 점검 + 0.5.0 마이그레이션 보완`

---

## Phase 2-A: 무중단 핸들러 주입 (브랜치 `feat/hot-swap`, 워크트리)

### Task A0: wasm3 + wasm32 실기기 스파이크 (판정 게이트)

**Files:**

- Create: `examples/rn-wasm-spike/` (독립 예제 — 패키지 본체 오염 금지)
- Modify: `docs/compatibility-matrix.md` (판정 기록)

**Step 1: rustra core wasm32 빌드 스파이크** — examples/rn-wasm-spike/backend에서
`rustra`를 dep로 wasm32 빌드 (worker pool 축소 필요 시 cfg 게이트 — **파일은 spike
디렉토리 안에서만 패치, 본체 변경 시 설계 문서에 반영 후 진행**).
피처 계산기 정도의 최소 백엔드 + postcard wire round-trip을 호스트 테스트로.

**Step 2: wasm3 탑재 RN 앱 스파이크** — react-native-bare-calculator 포크:
iOS는 wasm3 정적 링크 (C 라이브러리, W^X 안전), Android는 JNI 래퍼.
`.wasm`을 assets로 번들 → 앱 기동 시 읽어 wasm3 인스턴스화.

**Step 3: 스왑 PoC** — 개발 중 새 .wasm을 기기 푸시(iOS: 파일 교체 후 앱 내
re-instantiate, Android: adb push) → 앱 재시작 없이 엔진 교체 → 동일 command 호출.

**Step 4: 판정 + 기록**

Run: 스파이크 앱에서 native(staticlib) 응답 vs wasm3 응답 바이트 비교
Expected: **바이트 동일** → 합격. 틀리거나 성능/안정성 문제로 불가 → 불합격.

- 합격: compatibility-matrix에 기록하고 Task A1 착수
- 불합격: 결과를 compatibility-matrix에 기록, Track A는 A0에서 종료.
  대체 산출물: RN 경계 문서 + `@rustra/testing` 목업 가이드 (이 문서만 커밋)

### Task A1: Node/Bun/Tauri cdylib 핫스왑

**Files:**

- Modify: `packages/cli/src/dev.ts` (reload 오케스트레이션)
- Modify: `packages/node/src/*.ts` (재로드 지원 — FFI 핸들 무효화 재초기화)
- Test: `packages/cli/src/dev.test.ts`

**Step 1: 실패 테스트** — dev 루프가 cargo build 성공 후 엔진 재초기화 트리거를
호스트에 전달하고, 진행 중 invocation 완료까지 대기(또는 얕은 취소)하는지.

**Step 2: 구현** — 기존 dev 루프의 build→codegen 파이프라인 뒤에
reload 이벤트 훅. Node/Bun은 FFI 라이브러리 언로드가 안전하지 않을 수 있으므로
1차 구현은 **프로세스 내 엔진 상태 리셋 + 새 바이너리는 다음 프로세스 시작 시
적용**과 **진짜 dlopen 스왑** 중 스파이크 결과로 선택 — 둘 다 합격이면 후자.

**Step 3: green → Commit** — `feat(dev): Node/Bun/Tauri cdylib 핫스왑 오케스트레이션`

### Task A2: rustra_ffi_hot_reload + parity 게이트

**Files:**

- Create: `crates/rustra/src/ffi_hot_reload.rs`
- Modify: `crates/rustra/src/lib.rs` (mod 선언)
- Test: `crates/rustra/src/ffi_hot_reload_tests.rs` (또는 ffi_tests.rs 확장)

**Step 1: 실패 테스트** — 동일 스키마의 핸들러 집합 blob(이름→교체 핸들러) 주입 →
`replace()` 경로로 command_id 유지 확인, 진행 중 컨텍스트의 live_schema 재계산,
frozen 레지스트리는 `registry.frozen` 에러.

**Step 2: 구현** —

```rust
/// 핫 리로드 주입. 각 항목은 기존 명령 이름에 대응하며 replace() 의미론을 따른다.
/// 실험적 표면 — versioning-policy의 experimental 규칙 적용.
/// # Safety
/// ptr/len은 유효한 blob을 가리켜야 하고, registry는 초기화된 엔진이어야 한다.
pub unsafe extern "C" fn rustra_ffi_hot_reload(
    registry: *mut RustraRegistry,
    handlers_blob: *const u8,
    len: usize,
) -> i32;
```

blob 형식: postcard 직렬화된 (이름, wire 시그니처 해시) 목록 — 시그니처 불일치 항목은
건너뛰고 리포트에 포함 (loud, 조용한 스킵 아님).

**Step 3: parity 게이트 연결** — `dev.wasm.parityGate: true`(기본)일 때 dev 루프가
reload 전후 `rustra_ffi_contract_hash` + golden wire 호출을 대조, 불일치 시
리로드 거부.

**Step 4: green → Commit** — `feat(ffi): rustra_ffi_hot_reload (experimental)`

### Task A3: rustra dev wasm 타깃 + doctor 고지

**Files:**

- Modify: `packages/cli/src/dev.ts` (wasm 타깃 빌드·푸시 경로)
- Modify: `packages/cli/src/doctor-checks.ts` (wasm 경고)

**Step 1: 실패 테스트** — `dev.target=wasm`일 때 dev가 wasm32 빌드를 오케스트레이션하고
doctor가 "협동형 취소만 유효 — 릴리스 전 native 검증 필수" 출력.

**Step 2: 구현 → green**

**Step 3: 릴리스 가드** — `scripts/check-release-coherence.mjs`에 규칙 추가: release
아티팩트 경로에 wasm 백엔드가 포함되면 fail.

**Step 4: Commit** — `feat(dev): wasm 타깃 dev 루프 + doctor 고지 + 릴리스 가드`

---

## Phase 2-B: 인스펙터 (브랜치 `feat/inspector`, 워크트리)

### Task B1: 표준 덤프 API

**Files:**

- Create: `crates/rustra/src/ffi_snapshot.rs` + 테스트
- Modify: `packages/types/src/inspector.ts` (DumpedWire 타입 + 디코더)
- Test: `packages/types/src/inspector.test.ts`

**Step 1: 실패 테스트 (Rust)** — `captureSnapshot`이 contractHash/schemaGeneration/
commands(id, name, capability)/limits/stats를 노출. 기존 FFI 재조립(신규 직렬화 형식
최소화 — 기존 get_schema/contract_hash를 조합).

**Step 2: TS 타입 + 스키마 주도 디코더** — 기존 complex-codec 디코더 재사용.
golden PINNED hex 케이스로 디코더 테스트.

**Step 3: green → Commit** — `feat(inspector): 표준 스냅샷 FFI + DumpedWire 디코더`

### Task B2: rustra inspect CLI

**Files:**

- Create: `packages/cli/src/cli-inspect.ts`
- Modify: `packages/cli/src/index.ts` (커맨드 라우팅), `cli-help.ts`
- Test: `packages/cli/src/inspect.test.ts`

**Step 1: 실패 테스트** — dump 파일(hex 또는 raw) → 스키마 주도 파싱 → 필드 트리
텍스트 출력. 잘못된 바이트는 위치+사유 에러 (loud).

**Step 2: 구현 → green → Commit** — `feat(cli): rustra inspect 커맨드`

### Task B3: 타임라인 리포트 생성기

**Files:**

- Create: `packages/devtools/src/timeline-report.ts` (DevtoolsLog[] → 정적 HTML)
- Test: `packages/devtools/src/timeline-report.test.ts`

**Step 1: 실패 테스트** — 로그 배열 → self-contained HTML(인라인 CSS, 외부 의존 0)에
명령·지연시간·에러·batch 구조 렌더. escape 처리 (payload 문자열에 HTML 있어도 안전).

**Step 2: 구현 → green → Commit** — `feat(devtools): 정적 타임라인 리포트 생성기`

### Task B4: 계약 diff 진단

**Files:**

- Modify: `packages/cli/src/schema-diff.ts`, `schema-diff-format.ts`
- Test: `packages/cli/src/schema-diff.test.ts`

**Step 1: 실패 테스트** — mismatch 시나리오 3종 (command_id displacement / alias
누락 / 타입 변경) → 각각 원인 지목 문장이 diff 출력에 포함.

**Step 2: 구현 → green** — OTA onContractMismatch에 진단 객체 전달 경로 확인
(packages/types contract-mismatch 콜백 타입 확장).

**Step 3: Commit** — `feat(cli): 계약 mismatch 원인 진단 (diff 확장)`

---

## 결합 (Phase 2 종료)

- 통합 브랜치에서 A+B 머지 → `cargo clippy --all-targets -- -D warnings`,
  `bun run test`, `bun run test:compat`, `bun run test:architecture` 전부 green.
- 결합부 결함 패턴 대비: **dumpWire가 ArrayBufferView 받는지**, dev.test mock이
  mode/ready 포함하는지 — 저번 결합부 결함 2건의 재발 확인.
- changeset 작성 (minor) → Version PR은 Release 워크플로 자동 생성.
- crates.io 발행은 수동 (사용자 승인 별도).

## Verification

- 각 태스크 커밋 시 focused test green + 전체 `bun run test`는 태스크 경계마다.
- Phase 완료마다: clippy -D warnings (base red 여부 먼저 확인 — 게이트 파손은
  diff 이전에 점검), fmt, test:architecture, test:api-surface.
- 스파이크 A0는 실기기 증빙(스크린샷/로그)까지 compatibility-matrix에 남긴다.
