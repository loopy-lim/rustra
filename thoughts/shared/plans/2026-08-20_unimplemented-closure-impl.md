# 미구현 항목 전수 마감(Unimplemented Closure) 구현 계획

> **상태: 구현 완료 (2026-08-20)** — 브랜치 `feat/unimplemented-closure`, 커밋 8개.
> 검증: cargo 235 pass / npm 전 suite green / clippy·prettier clean. 발행 대기 changeset 1건.

## 개요

전수조사(26건)로 확인된 미구현/결함을 8개 워크스트림 → 6개 Phase로 마감한다. 최우선은 2개 HIGH 결함(코드젠 무음 필드 삭제, rust-api-guide 허위 서술)이며, 이후 온보딩 완결(Node transport/매트릭스/레퍼런스 앱), 취소·의미론 완성, 고아 추상 정리, 성능 후속, Tier 3 바이너리 확장 순서다.

## 현재 상태 분석

- main @ d9215a4e, PR #16(Lynx 제거) 직후. 워크스페이스는 3 crates + 11 packages + 8 examples.
- HIGH 결함 2건: ① `packages/cli/src/generate.ts:165-206`의 `classifyPostcardField` null 경로 + 무음 스킵 → crud 생성 코덱 4개 명령 오염(`examples/crud/generated/rkyv-codecs.ts:287,318,325-332,350`). ② rust-api-guide 7건 허위 서술(cargo check 검증 완료).
- CI 게이트: `npm test`(types/ts:node/packages/cli), `test:compat`(runtime 포함), `lint:rust`, `lint`+`format:check`.
- 코드젠 dual-path 관례: Rust bin + TS CLI 양쪽 재생성, generated/는 prettier 제외 (메모리 `codegen-dual-path-regen`).
- 커밋 관례: lefthook이 prettier 포맷하나 재스테이징 안 함 → 커밋 후 `git commit --amend --no-edit` (메모리 `lefthook-prettier-amend`).

### 주요 발견사항:

- 엔진 Tier 3 JSON 폴백(`packages/types/src/index.ts:780-795`)은 "코덱 미등록" 시에만 동작 — 깨진 코덱이 등록되면 선점당함. 따라서 수정 원칙은 **"부분 코덱은 등록 금지" 불변식**이다.
- crud 테스트가 mockEngine(JSON)만 써서 와이어 미경유 → 결함이 CI에 안 걸림. round-trip 스모크 테스트가 구조적 해법.
- 매크로(`crates/rustra-macros/src/lib.rs:100-120,151-159`)는 단일 Input/`Result<O>`만 허용하도록 의도 설계됨 — 문서가 틀렸지 매크로를 확장할 게 아니다.
- WS7 caller-buffer fastpath는 `docs/plans/2026-08-35-perf-close-nitro-gap.md` Task 7 설계, WS4 취소는 followup3 계획의 "별도 결정" 항목 — 설계 맥락 존재.

## 목표 상태

26건 전부 "구현됨 + 검증됨" 또는 "의도적 계약으로 문서화됨" 상태. 모든 자동 검증 명령 green, changeset 작성(발행은 별도 승인), 문서-코드 불일치 0건.

## 범위 제한 (하지 않을 것)

- npm/crates.io 발행 없음 (changeset까지만)
- 무중단 핫 리로드 주입 별트랙 유지
- Android 실기기/에뮬레이터 측정, iOS 디바이스 빌드 측정 (문서화만)
- Lynx 부활 없음 (잔여물 제거만)
- 매크로 확장(스칼라 멀티파라미터/bare 반환 허용) 없음 — 문서 수정으로 해결
- 성능 수치 목표 없음 (기능 구현 + 벤치마크 반영까지만)

## 구현 접근 방식

Phase 순서는 의존성 기반: 결함 수정(문서·코드젠) → 온보딩(정확한 코덱 위에 얹힘) → 취소/고아 추상(코드 변경, 문서 의존 낮음) → 성능/Tier3(독립적, 마지막). 각 Phase 종료 시 자동 검증 + 커밋(+amend). 브랜치는 `feat/unimplemented-closure` 단일 브랜치, Phase별 커밋 분리.

---

## Phase 1: 코드젠 정확성 (WS1 — HIGH)

### 개요

코드젠 무음 필드 삭제 결함을 수정하고, 재발 방지용 round-trip 스모크 테스트를 추가하며, 타입 커버리지(allOf/integer enum)와 스테일 산출물을 정리한다.

### 필요한 변경사항:

#### 1. classifyPostcardField 무음 스킵 제거

**파일**: `packages/cli/src/generate.ts:165-206`
**변경사항**: `if (!kind) continue;` 경로를 제거한다. 라운드트립 불가 명령(지원 불가 필드 포함)은 코덱 생성에서 **제외**하고 `console.warn`으로 명시: `WARN: command 'updateItem' has unsupported field types (name: Option<String>); falling back to Tier 3 JSON`. optional 필드 스킵(`:204`)도 같은 원칙 적용 — optional이더라도 지원 타입이면 인코딩에 포함, 미지원이면 제외+경고.

#### 2. 레지스트리 불변식: 부분 코덱 등록 금지

**파일**: `packages/cli/src/generate.ts` (registry 생성부), `examples/*/generated/rkyv-registry.ts` (재생성)
**변경사항**: 입력·출력 중 하나라도 완전 코덱이 아니면 그 명령은 registry에서 제외 → 엔진이 Tier 3 JSON 폴백으로 라우팅. 생성기가 "지원 필드 전부 or 제외"를 보장.

#### 3. crud 예제 재생성 + 와이어 round-trip 테스트

**파일**: `examples/crud/generated/*` (재생성), 신규 `examples/crud/ts/wire-round-trip.test.ts`
**변인사항**: dual-path 재생성(Rust bin + TS CLI). 신규 테스트는 mock이 아닌 **실제 코덱 + Rust 핸들러** 경유: `updateItem` 인코딩 바이트를 Rust `postcard::from_bytes` 디코드와 대조하거나, JS 코덱 인코딩→JS 코덱 디코딩 round-trip + Rust 스키마와 필드 구조 대조. 최소한: "registry에 등록된 코덱은 입력/출력 전 필드 round-trip 성공" 단언.

#### 4. allOf / integer enum 지원

**파일**: `crates/rustra/src/codegen.rs`, `packages/cli/src/generate.ts`(및 `codegen.ts`), 양쪽 테스트
**변경사항**: `allOf` → TS `A & B` intersection 생성. integer enum → `1 | 2 | 3` 리터럴 union (TS `codegen.ts:51`의 전역 따옴표 처리를 enum 원시 타입별 분기). Rust bin과 TS CLI가 동일 산출물 생성(dual-path 일치 테스트 갱신).

#### 5. postcard 필드 순서 경고

**파일**: `packages/cli/src/generate.ts:187-193` 부근
**변경사항**: 스키마 필드 순서가 postcard 알파벳 순 가정을 위반하면 `WARN` 출력. (Rust bin 쪽도 동일하게)

#### 6. auth/streaming generated/ 재생성

**파일**: `examples/auth/generated/`, `examples/streaming/generated/`
**변경사항**: dual-path 재생성으로 rkyv-codecs/rkyv-registry 추가 — calculator/crud와 동일 구조.

#### 7. init 템플릿 버전 갱신

**파일**: `packages/cli/src/index.ts:195-196`
**변경사항**: `^0.1.1` → `^0.1.3` (또는 package.json 워크스페이스 버전 읽기).

#### 8. 코드젠 문서 갱신

**파일**: `docs/internal/codegen.md:233-243`
**변경사항**: 제한사항 표 갱신 — allOf/integer enum 해소, oneOf/const 행 정정(이미 구현됨), 무음 스킵→경고+제외 정책 문서화.

### 성공 기준:

#### 자동 검증:

- [x] `npm run test -w @rustra/cli` 통과 (신규 코드젠 테스트 포함)
- [x] `npm run test:ts:node` 통과 (crud wire round-trip 테스트 포함)
- [x] `cargo test -p rustra` 통과 (codegen.rs 변경분)
- [x] `npm run lint && npm run format:check` 통과
- [x] crud 재생성물에서 `updateItem`이 더 이상 필드를 소실하지 않음 (폴백 경유 or 완전 코덱)

#### 수동 검증:

- [x] `rustra generate` 실행 시 crud 스키마에서 WARN 로그 확인 (미지원 명령 폴백 안내)
- [x] auth/streaming generated/ 구조가 calculator/crud와 동일

---

## Phase 2: API 문서 정합성 (WS2 — HIGH)

### 개요

rust-api-guide를 실제 API로 재작성하고, 스테일 문서 5종을 현행화한다.

### 필요한 변경사항:

#### 1. rust-api-guide.md 재작성

**파일**: `docs/rust-api-guide.md`
**변경사항**: 허위 서술 7건 수정 — 스칼라 멀티파라미터→단일 Input 구조체 필수, bare/unit 반환→`Result<O>` 필수, `#[bridge(rename_all)]`→미지원 명시, `generate_to`/`register`/`build()`→`generate_typescript()?.write_to_dir()`/`command_fn()`/`build!` 매크로. 0-파라미터 커맨드 허용으로 정정. 누락 API 추가: 이벤트 버스(emit/set_event_sink), FFI(register_ffi/async/cancel/max_payload), grant_capability/require_capability, alias_command_id, schema_version, freeze, tauri_support.

#### 2. compatibility-contract.md RN 현행화

**파일**: `docs/compatibility-contract.md:31,67`
**변경사항**: "missing-native-module 미달" 서술 → RN JSI 네이티브 모듈 구현·실기 검증(0.95µs)·CI Release 완료 상태로 갱신.

#### 3. security-audit.md runner/ 제거

**파일**: `docs/security-audit.md:17-18,30`
**변경사항**: 삭제된 `runner/` 경로 참조 제거.

#### 4. 마스터플랜 진척 표 갱신

**파일**: `docs/plans/2026-05-14-project-improvement-masterplan-design.md:134-145`
**변경사항**: streaming/auth 예제, 마이그레이션 가이드 ❌→✅ 갱신 + 이번 마감 항목 반영.

#### 5. docs/README.md 목록 보충

**파일**: `docs/README.md`
**볍경사항**: rust-api-guide/release-procedure/security-audit 추가.

#### 6. --cpp-output 문서화

**파일**: `docs/extending/react-native-setup.md`, `docs/getting-started.md`
**변경사항**: `--cpp-output` 옵션 설명·사용 예 추가.

### 성공 기준:

#### 자동 검증:

- [x] 가이드 내 Rust 예제가 실제 컴파일된다 — 예제 코드를 `crates/` 독스트/테스트로 추출해 `cargo test -p rustra --doc` 또는 별도 doctest 크레이트로 검증
- [x] `npm run format:check` (문서는 prettier 대상 밖이지만 CI 통과 유지)

#### 수동 검증:

- [x] 가이드의 예제 3개 이상 신규 프로젝트 흐름(온보딩 순서)대로 따라가면 끊김 없음
- [x] compatibility-contract에 낡은 RN 서술 잔여 없음 (grep "missing-native-module" 0건)

---

## Phase 2.5: 취소/의미론 완성 (WS4)

### 개요

조용한 드롭/얕은 취소를 완성한다. 전제 인프라(invokeTypedAsync id 노출, invokeCancel)는 follow-up 3에서 완료된 상태라 비용이 낮다.

### 필요한 변경사항:

#### 1. typed/tier-3 취소 전파 확장

**파일**: `packages/types/src/index.ts:809-813`
**변경사항**: `!onTypedPath &&` 조건 완화 — typed(tier 1)/tier 3 동적 경로에서도 `invokeAsync`+`invokeCancel` 노출 시 전파형 취소. RN JSI(invokeTypedAsync) 경로 포함. 3-tier × 취소 매트릭스 테스트 추가.

#### 2. tier-3 getLiveSchema throw

**파일**: `packages/types/src/index.ts:392-395`
**변경사항**: `getSchema` 미노출 네이티브에서 빈 Map 조용 반환 → 명시적 에러 throw (`schema.unavailable`류). 테스트 갱신.

#### 3. invokeTypedBatch 취소 계약 문서화

**파일**: `packages/types/src/index.ts` (JSDoc), `docs/` 해당 절
**변경사항**: 배치 동기 루프의 취소 미지원을 명시적 계약으로 JSDoc+문서화. (배치 재설계 자체는 범위 밖 — followup3의 유예 결정 유지)

### 성공 기준:

#### 자동 검증:

- [x] `npm run test:types` 통과 (취소 매트릭스 테스트 포함)
- [x] `npm run test:ts:node` 통과 (crud/calculator 기존 테스트 회귀 없음)

#### 수동 검증:

- [x] abort 시 핸들러가 실제 중단되는지 RustraJSIBridge.cpp 경유 확인 (iOS 시뮬레이터 또는 코드 리뷰 수준)

---

## Phase 3: 온보딩/DX 완결 (WS3)

### 개요

"5분 온보딩"을 끊김 없게 만든다: Node transport 제공, 호환성 매트릭스 문서, @rustra/react 레퍼런스 앱.

### 필요한 변경사항:

#### 1. createNodeProcessTransport

**파일**: `packages/node/src/index.ts` (현재 33줄), `packages/node/package.json`, 신규 테스트
**변경사항**: subprocess 또는 napi 기반 transport 구현. `examples/calculator-napi`의 napi 패턴 참조. getting-started Node 퀵스타트를 사용자 구현 없는 복붙 코드로 갱신.

#### 2. 호환성 매트림스 문서

**파일**: 신규 `docs/compatibility-matrix.md`, `docs/README.md` 목록 추가
**변경사항**: signal/취소/invokeBatch/이벤트 × node/bun/tauri/RN 표. node/bun의 signal 조용 드롭은 loud error로 전환하고 매트릭스에 반영 (node/bun `invoke` 시그니처에 options 파라미터 추가, 미지원 시 throw).

#### 3. @rustra/react 레퍼런스 앱

**파일**: 신규 `examples/reference-app/` (React + @rustra/react 훅)
**package.json**: `test:app:reference` 스크립트 추가
**변경사항**: CRUD + 이벤트를 useCommand/useMutation/useEvent/RustraProvider로 구현. Node transport(Phase 3-1) 사용. 타입체크+스모크 실행 포함.

### 성공 기준:

#### 자동 검증:

- [x] `npm run test:packages` 통과 (node transport 테스트 포함)
- [x] `npm run test:app:reference` 통과 (typecheck + 스모크)
- [x] `npm run test:compat` 전체 통화 (signal loud error 변경에 따른 어댑터 테스트 갱신 포함)

#### 수동 검증:

- [x] getting-started Node 퀵스타트를 새 디렉터리에 복붙해 실행하면 동작
- [x] 레퍼런스 앱에서 생성·조회·수정·이벤트 수신 흐름 동작

---

## Phase 4: 고아 추상/잔여물 정리 (WS5)

### 개요

인터페이스는 남고 소비자가 사라진 고아들을 정리하고 Lynx 잔여물을 제거한다.

### 필요한 변경사항:

#### 1. contractHash JSI 배선

**파일**: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp` (iOS/Android 공유)
**변경사항**: `getContractHash` JSI 메서드 노출 + `RkyvV2EngineOptions.contractHash` 옵션 전달 경로 확보. Rust FFI `rustra_ffi_contract_hash`(ffi.rs:768) 활용.

#### 2. RendererHost 존속 문서화

**파일**: `crates/rustra/src/renderer_host.rs` 모듈 독
**변경사항**: 공개 API 유지하되 모듈 독에 "Lynx 제거 후 고아, 호스트 통합 지점 인터페이스" 배경과 사용처 안내 기록. `#[allow(dead_code)]` 정리 가능한 것 정리.

#### 3. invokeAsync(payload,onDone) 계약 문서화

**파일**: `packages/types/src/index.ts:376` JSDoc
**변경사항**: "호스트 구현 계약" — 전파형 취소용 옵셔널 메서드임을 JSDoc 명시.

#### 4. Lynx 잔여물 제거

**파일**: `packages/lynx/dist/`(rm), `examples/react-native-calculator/modules/nitro-bench/nitro-bench/src/specs/Example.nitro.ts`(rm), `crates/rustra/tests/trust_baseline_ffi.rs:9-12` 모듈 독 갱신, "(T3 후속)" 낡은 마커 4곳(`crates/rustra/tests/payload_robustness.rs:210,336`, `examples/calculator/src/lib.rs:615` 등) 정리
**변경사항**: 디스크 잔여물 삭제 + 낡은 주석 갱신. `scripts/clean-local.sh` 대상 목록에 packages/lynx 추가(있다면).

#### 5. RN B1 체크리스트 폐쇄

**파일**: `docs/plans/2026-08-10-rn-b1-verification.md`
**변경사항**: 23항목을 "CI/벤치마크로 대체 폐쇄" 처리 — 각 항목 매핑(어느 CI 게이트/벤치마크가 대체하는지) 부기 후 체크박스 표기.

### 성공 기준:

#### 자동 검증:

- [x] `cargo test -p rustra` 통과 (주석 정리 후에도)
- [x] `npm run test:app:react-native` (typecheck) 통과 — JSI 배선 변경 포함
- [x] `cargo clippy --all-targets -- -D warnings` 통과

#### 수동 검증:

- [x] RN 앱에서 contractHash 옵션 켰을 때 unenforceable throw가 더 이상 발생하지 않음 (시뮬레이터 또는 코드 경로 리묰)
- [x] 저장소에 lynx 참조 잔여 없음 (`grep -ri lynx`가 문서의 역사 기록 제외 0건)

---

## Phase 5: 성능 후속 (WS7)

### 개요

의도적 유예였던 2개 성능 후속을 구현한다: caller-buffer fastpath와 positional facade.

### 필요한 변경사항:

#### 1. FFI caller-buffer fastpath

**파일**: `crates/rustra/src/ffi.rs` (신규 caller-buffer 변형), `packages/types`/`packages/react-native` (호출측), `docs/benchmarks.md`
**변경사항**: Rust malloc→복사→JS memcpy 3중 복사 제거. 설계 참조: `docs/plans/2026-08-18-perf-close-nitro-gap.md` Task 7. 벤치마크 항목 추가·갱신.

#### 2. positional facade 코드젠

**파일**: `packages/cli/src/generate.ts`, `crates/rustra/src/codegen.rs` (dual-path)
**변경사항**: 정적 명령용 `__rustraNative.xxx(a, b)` positional 시그니처 생성. 기존 코덱 경로와 공존(옵션). rkyv V2 게이트 경로 수정 포함.

### 성공 기준:

#### 자동 검증:

- [x] `cargo test -p rustra` 통과 (caller-buffer FFI 테스트)
- [x] `npm run test -w @rustra/cli` + `test:ts:node` 통과 (positional facade 생성 테스트)
- [x] `npm run bench` 실행 성공 (수치 기록은 문서 반영)

#### 수동 검증:

- [x] benchmarks.md에 caller-buffer/positional 벤치마크 결과 반영
- [x] Nitro 격차 수치 갱신

---

## Phase 6: rkyv Rust Tier 3 바이너리 확장 (WS8)

### 개요

Rust 디코더 Tier 3의 바이너리(postcard) 와이어 지원을 중첩 구조체/enum/Option으로 확장한다. JSON 폴백은 유지된다.

### 필요한 변경사항:

#### 1. Tier 3 postcard 확장

**파일**: `crates/rustra/src/rkyv_codec.rs:44` 부근
**변경사항**: `build_tier3_json_decoder` 확장 — 중첩 구조체/enum(anyOf)/`Option<T>` 필드의 postcard 디코딩. 기존 JSON 폴백 유지: 확장 후에도 미지원 조합은 JSON 폴백.

#### 2. crud 예제가 바이너리 경로 이용하도록 (가능 시)

**파일**: `examples/crud/`
**변경사항**: Tier 3 확장 후 crud의 미지원 명령이 JSON 폴백 대신 바이너리 코덱 이용 가능하면 전환. (자동: Rust 측 지원 범위 확장 시)

### 성공 기준:

#### 자동 검증:

- [x] `cargo test -p rustra` 통과 (Tier 3 신규 디코더 테스트: 중첩/enum/Option round-trip)
- [x] `npm run test:ts:node` 통과 (crud 회귀 없음)

#### 수동 검증:

- [x] rkyv_codec.rs 주석 갱신 (지원 범위 현행화)

---

## 테스트 전략

### 단위 테스트:

- 코드젠: classifyPostcardField 전 유니온 커버, allOf/integer enum 생성, 필드 순서 경고, 부분 코덱 제외 + WARN
- 취소: 3-tier × 전파/얕은 매트릭스
- transport: createNodeProcessTransport 라이프사이클(spawn/kill/재시작)
- Tier 3: 중첩 구조체/enum/Option round-trip

### 통합 테스트:

- crud wire round-trip (실제 코덱 ↔ Rust postcard)
- signal loud error 전환 후 node/bun/tauri/RN 어댑터 전체 (`test:compat`)
- 레퍼런스 앱 스모크 (CRUD+이벤트)

### 수동 테스트 단계:

1. getting-started 복붙 → 실행
2. RN 앱 contractHash 켜기
3. `rustra generate` WARN 확인
4. bench 실행 후 benchmarks.md 갱신

## 성능 고려사항

- caller-buffer fastpath는 기존 경로와 공존 — 필요 시 게이트/옵션으로 선택 가능하게. 회귀 방지: 기존 벤치마크 수치 보존
- positional facade 생성물은 옵션 경로 — 기본 비활성 또는 동등 산출물 검증 후 전환

## 마이그레이션 참고사항

- crud 등 기존 generated/ 재생성 시 산출물이 달라짐(제외+경고) — 다운스트림 테스트 갱신 필요
- signal loud error는 파괴적 변경(조용한 드롭→throw) — changeset에 minor/bump 표기. 기존 테스트 중 options 미사용 케이스는 영향 없음
- 문서 재작성으로 외부 사용자가 보는 계약 문서가 바뀜 — compatibility-contract 갱신 시 마이그레이션 가이드 상호 참조 확인

## 참고 자료

- SPEC: `thoughts/shared/specs/2026-08-20_unimplemented-closure.md`
- 리서치: `thoughts/shared/research/2026-08-20_09-55-00_unimplemented-survey.md`
- 성능 설계: `docs/plans/2026-08-18-perf-close-nitro-gap.md` Task 7
- 취소 설계: `docs/plans/2026-08-18-followup3-typed-async-id-batch-cancel.md`
- dual-path 재생성 관례: 메모리 `codegen-dual-path-regen`
