# 성장 건덕지 전수 구현(Growth Closure) 구현 계획

> **상태: 진행 중** — 브랜치 `feat/growth-closure`

## 개요

6각도 조사(70여 건)로 확인된 성장 후보를 7개 워크스트림 → 6개 Phase로 구현한다. 최우선은 PR #29 이후 신규 발견된 결함 6건(WS1)이고, 이후 코어 안전성·성능(WS2/3) → JS 패키지(WS4) → 이벤트·비동기 스토리(WS5/6) → CI·문서·시장(WS7) 순서다.

## 현재 상태 분석

- main @ f77c2b86, PR #29(프로덕션 준비성 감사) 병합 직후. 워크스페이스는 3 crates + 10 packages + 9 examples.
- 결함 6건의 근거는 리서치 문서 "코드 참조" 섹션에 파일:줄로 확정됨.
- CI 게이트: `npm test`(types/ts:node/packages/cli), `test:compat`, `lint:rust`(clippy -D warnings), `lint`+`format:check`.
- 코드젠 dual-path 관례: Rust bin + TS CLI 양쪽 재생성, generated/는 prettier 제외 (메모리 `codegen-dual-path-regen`).
- 커밋 관례: lefthook이 prettier 포맷하나 재스테이징 안 함 → 커밋 후 `git commit --amend --no-edit` (메모리 `lefthook-prettier-amend`).

### 주요 발견사항:

- release capability 결함은 `AtomicBool::new(!cfg!(debug_assertions))` 초기값이 원인 — freeze 예외 또는 빌더 사전 grant로 해소하며, 기존 테스트 `grant_capability_blocked_when_frozen`은 "동결 후 register 차단" 의미로 재조정한다.
- useCommand minify 문제는 코드젠 산출물에 이미 `commandId` 상수가 있어 규약(`fn.commandId` 우선, `.name` 폴백)으로 즉시 해결 가능.
- 이벤트는 Rust측 `register_with_events`(Tauri emit), `drain_events`(폴링) 인프라가 이미 있어 JS 표면 개통이 핵심.
- Node persistent transport는 Rust 예제에 루프형 stdio 런타임(bin) 추가가 전제 — 계약은 기존 JSON 프레임 재사용.

## 목표 상태

SPEC의 WS1~WS7 체크박스 전부 "구현됨 + 검증됨". 자동 검증 명령 전부 green, changeset 작성(발행은 별도 승인), 문서-코드 불일치 0건.

## 범위 제한 (하지 않을 것)

- npm/crates.io 발행 없음 (changeset까지만)
- 실기기/시뮬레이터 측정, Windows 실기기 수동 검증 없음 (CI/문서까지만)
- WASM/Electron 전용 패키지, 프리빌트 npm 발행, 무중단 주입, 배치 항목별 취소 네이티브 구현 — 별트랙
- breaking change 없음

## 구현 접근 방식

Phase 순서는 의존성 기반: 결함(문서·설계 확정) → 코어(Rust, JS가 의존) → JS 패키지(코어 위) → 이벤트/비동기(신규 표면) → CI/문서/시장(마지막 정리). 각 Phase 종료 시 자동 검증 + 커밋(+amend). 브랜치 `feat/growth-closure` 단일 브랜치, Phase별 커밋 분리.

---

## Phase 1: 즉시 결함 수리 (WS1)

### 개요

PR #29 이후 발견된 결함 6건 + 발행 인프라 3건을 수정한다. 전부 독립적이라 병렬 가능.

### 필요한 변경사항:

#### 1.1 release capability 결함
**파일**: `crates/rustra/src/lib.rs:1414, 862-887`
**변경사항**: `grant_capability`가 freeze 상태와 무관하게 동작하도록 `ensure_mutable` 호출 제거(grant는 권한 부여이지 레지스트리 구조 변경이 아님). register/unregister/replace만 동결 대상 유지. 테스트: release cfg 조건 테스트 + 기존 `grant_capability_blocked_when_frozen`(lib.rs:1731-1744)을 "register는 차단, grant는 허용" 의미로 재작성.

#### 1.2 `#[command(capability = "...")]` 속성
**파일**: `crates/rustra-macros/src/lib.rs:40-57`, `crates/rustra/src/lib.rs:1240-1256`
**변경사항**: `CommandAttr`에 `capability` 파싱 추가. 매크로가 메타 상수(`__RUstra_meta_*` 패턴)에 capability를 싣고 `require_capability`가 문자열 대신 심볼 참조를 받는 경로 추가(문자열 API는 deprecated 아님, 병행 유지).

#### 1.3 README 퀵스타트 수정
**파일**: `README.md:43, 124` 및 문서 전체 스윕
**변경사항**: `add_numbers(a, b) -> i64`를 단일 Input 구조체 + `Result<Output>` 패턴으로 교체. rust-api-guide.md:496 잔여 1건 동시 수정.

#### 1.4 minify-안전 명령 식별
**파일**: `packages/cli/src/generate.ts`(commandId 상수 노출 확인), `packages/react/src/useCommand.ts:31`, `useMutation.ts:30`, `packages/testing/src/index.ts:54`
**변경사항**: `resolveCommandName(fn)`: `fn.commandId`(코드젠이 부여) 우선, 없으면 `.name` 폴백. 코드젠이 생성 팩토리에 `commandId` 프로퍼티 심기.

#### 1.5 signal 정책 통일
**파일**: `packages/node/src/index.ts:46-59`, `packages/bun/src/index.ts:45-58`, `packages/tauri/src/index.ts:69-81`
**변경사항**: `invoke`가 options를 받는다. 미abort signal은 무시하고 정상 실행, abort된 signal은 `cancelled` 에러. 매트릭스 문서 갱신.

#### 1.6 devtools options 보존
**파일**: `packages/devtools/src/index.ts:57-60`
**변경사항**: `invoke(command, args?, options?)` 시그니처 + 전달. invokeBatch도 동일.

#### 1.7 release.yml 버전 동적화 + provenance
**파일**: `.github/workflows/release.yml:108, 64-74`
**변경사항**: `cargo info rustra-macros@$(cargo metadata에서 파싱)`로 교체. env에 `NPM_CONFIG_PROVENANCE: true` 추가.

#### 1.8 CHANGELOG 0.2.0
**파일**: `CHANGELOG.md`
**변경사항**: 0.2.0 엔트리 작성 (PR #17/#29 내용 집계, 패키지별 CHANGELOG와 정합).

### 성공 기준:

#### 자동 검증:
- [ ] `cargo test -p rustra` — grant/freeze 재조정 테스트 포함 green
- [ ] `cargo test -p rustra-macros` — capability 속성 테스트 green
- [ ] `npm run test:packages` — react/testing/devtools/node/bun/tauri 테스트 green
- [ ] `npm run lint && npm run format:check` green
- [ ] README 예제가 `examples/` 패턴과 정합 (육안 + grep 스칼라 멀티파라미터 0건)

---

## Phase 2: 코어 안전성·정확성 (WS2)

### 개요

FFI 경로의 정확성(probe 2회 실행), 안전성(spawn 가드, free 역참조), 일관성(에러 포맷)을 확보한다.

### 필요한 변경사항:

#### 2.1 probe 1회 실행 프로토콜
**파일**: `crates/rustra/src/ffi.rs:493-556`
**변경사항**: probe 호출의 결과를 invocation별 1회 캐시(ThreadLocal 또는 마지막 probe 결과 재사용 — 단일 호출 흐름에서 probe→write가 연속하므로 last-probe 캐시로 충분). 문서에 멱등성 보장 명시.

#### 2.2 async spawn 패닉 가드 + 선검사
**파일**: `crates/rustra/src/ffi.rs:627-700`
**변경사항**: `std::thread::spawn`을 catch_unwind로 감싸고 실패 시 invocation 완료 프레임 전송. 페이로드 복사 전 `max_payload_bytes()` 검사 이동.

#### 2.3 패닉 메시지 포맷 통일
**파일**: `crates/rustra/src/ffi.rs:297, 538`, `lib.rs:841-844`, `events.rs:102-106`
**변경사항**: 단일 `panic_message()` 헬퍼로 통일. JS 파서 정합 확인(`parseRustraErrorString`).

#### 2.4 `$ref` 재검증
**파일**: `crates/rustra/src/rkyv_codec.rs:604-612`
**변경사항**: `js_field_supported`이 definitions 맵을 받아 `$ref`를 실제 스키마까지 따라감. 미지원 도달 시 false → typed fast-path 비활성.

#### 2.5 rkyv V2 코어 FFI 심볼
**파일**: `crates/rustra/src/ffi.rs` (신규), `examples/calculator/src/lib.rs:1093-1210`
**변경사항**: `rustra_ffi_invoke_rkyv_v2`(sync/async/into 변형) 노출. calculator 래퍼를 코어 심볼 위임으로 교체. 테스트: 기존 trust_baseline + 신규 심볼 직접 테스트.

#### 2.6 emit 경고 + 에러 잘림 마커
**파일**: `crates/rustra/src/lib.rs:679-686`, `rkyv_codec.rs:360-372`
**변경사항**: 직렬화 실패 시 `eprintln!` 경고. `body_len` 잘림 시 `"…(truncated)"` 접미.

#### 2.7 free 문서화 + 최소 검사
**파일**: `crates/rustra/src/ffi.rs:785-819`
**변경사항**: 모듈 독에 release 제약 명시, null/정렬 검사 추가.

#### 2.8 테스트 공백 5건
**파일**: `crates/rustra/tests/` (payload_robustness 확장 등)
**변경사항**: caller-buffer robustness(잘못된 size/포인터), caller-buffer×async, Json 기본 디스패치, 이벤트 싱크 교체, 심볼 혼용 테스트 추가.

### 성공 기준:

#### 자동 검증:
- [ ] `cargo test -p rustra` green (신규 테스트 포함)
- [ ] `cargo clippy --all-targets -- -D warnings` green
- [ ] probe 2회 실행 회귀 테스트(카운터 핸들러) green

---

## Phase 3: 코어·브릿지 성능 (WS3)

### 개요

핫패스 부채를 제거한다. 측정 정밀화(벤치 통계)가 먼저고, 그다음 Arc<Value>, 단일 조회, caller-buffer rkyv V2, napi Buffer 순서다.

### 필요한 변경사항:

#### 3.1 Command 스키마 Arc화
**파일**: `crates/rustra/src/lib.rs:493-512, 744-753, 795-809`
**변경사항**: `input_schema/output_schema/definitions: Value` → `Arc<Value>`. clone-out은 여전히 Command clone이지만 이제 값싸다.

#### 3.2 u16→핸들러 직접 캐시
**파일**: `crates/rustra/src/lib.rs:794-809`
**변경사항**: 등록 시점에 `id_to_command: HashMap<u16, Arc<Command>>` 구축. dispatch에서 id_to_name→commands 이중 조회 제거.

#### 3.3 rkyv V2 caller-buffer
**파일**: `crates/rustra/src/ffi.rs`, `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp:351`
**변경사항**: `invoke_rkyv_v2_into` 심볼(Phase 2.5와 동일 구조). JSI 브릿지가 ArrayBuffer 선할당 후 caller 버퍼로 전달. (기기 측정은 범위 밖 — 로컬 벤치/논리 검증까지만)

#### 3.4 napi Buffer 반환
**파일**: `examples/calculator-napi/src/lib.rs:16-29`
**변경사항**: `rustra_invoke`가 `Buffer` 반환, `rustra_ffi_invoke_json_into` 재사용. 인자도 JSON String 유지(호환) 또는 Buffer 병행.

#### 3.5 caller-buffer JSON 임시 Vec 제거
**파일**: `crates/rustra/src/ffi.rs:493-556`
**변경사항**: `serde_json::to_writer` + 남은 용량 커서 어댑터. 오버런 시 usize::MAX 반환(기존 프로토콜 유지).

#### 3.6 벤치 통계 정밀화
**파일**: `scripts/transport-bench.mjs:106-124`, `examples/react-native-calculator/BenchmarkApp.tsx:225-235`, `docs/benchmarks.md`
**변경사항**: 트림드 평균(상하 5%), stddev, p99 로깅. docs 표 p99 열 채우기 + 세션 불일치 정비(2.9µs vs 24.3µs 재측정 or 각주).

#### 3.7 할당 횟수/콜드스타트 측정
**파일**: `examples/benchmark/src/main.rs`
**변경사항**: global_allocator 카운팅 훅(할당/해제 횟수, 호출당 델타), 콜드스타트(최초 invoke tier 해결) 측정 추가. 결과를 benchmarks.md에 반영.

### 성공 기준:

#### 자동 검증:
- [ ] `cargo test -p rustra` green (Arc 교체 회귀 없음)
- [ ] `cargo bench -p rustra --bench tier_compare` 동작(수치는 기록만)
- [ ] `npm run bench` 동작, 통계 출력에 p99/stddev 포함
- [ ] calculator 예제가 코어 심볼로 동작: `npm run test:runtime:node` green

---

## Phase 4: JS 패키지 완결 (WS4)

### 개요

JS 층의 조용한 드롭·누락을 메우고 타입 표면을 정리한다.

### 필요한 변경사항:

#### 4.1 RustraErrorCode 상수
**파일**: `packages/types/src/index.ts:124-126`
**변경사항**: `RustraErrorCode` const 객체(13종) + `isRustraErrorCode`. 문서화(docs 또는 README).

#### 4.2 mock 엔진 보강
**파일**: `packages/testing/src/index.ts:29-77`
**변경사항**: `invokeBatch` 지원, options 수신/기록(calls에 signal/timeoutMs), pre-aborted signal → cancelled. minify 규약(1.4) 적용.

#### 4.3 contract-gate matcher
**파일**: `packages/testing/src/contract-gate.ts`
**변경사항**: `toEqualContract(actual, expected)` expect 스타일 유틸 + 사용 문서. vitest/jest 양쪽에서 동작하는 순수 함수.

#### 4.4 RN 타입 미러링 해소
**파일**: `packages/react-native/src/index.ts:31-65`
**변경사항**: `RustraJSINative`이 `RkyvV2SchemaNative`를 extends하도록(RN 전용 메서드만 추가 선언).

#### 4.5 UTF-8 Writer 개선
**파일**: `packages/types/src/index.ts:366-388`, `packages/cli/src/codegen.ts:271-282`
**변경사항**: 사전 크기 추정 + 단일 Uint8Array Writer. TextEncoder 존재 시 우선 사용(RN Hermes에 없으므로 폴백 유지 — 메모리 `lynx-quickjs-no-textencoder` 참고).

#### 4.6 useCommand 경쟁 수정
**파일**: `packages/react/src/useCommand.ts:40-57`
**변경사항**: settled ref 패턴으로 unmount 후 setLoading/setData 전부 가드.

#### 4.7 byId 배치 JSI 구현
**파일**: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp`, `rustra-generated-codecs.cpp`
**변경사항**: `invokeTypedBatchById(cmdIds, payload)` — 단일 페이로드 배치 엔벨로프 재사용으로 cmd_id 배열 진입. JS 분기(`types/index.ts:1060-1063`) 활성화. 테스트: react-native-app 어댑터 스모크 + 매트릭스 갱신.

#### 4.8 positional facade 개선
**파일**: `packages/cli/src/generate.ts:1369-1447`
**변경사항**: `invokeTypedById` 진입 전환, `_options` 전달 배선(무시 제거), `Promise.resolve` 래핑 제거(동기 경로 반환). 코드젠 테스트 갱신.

#### 4.9 배치 취소·typed 취소 계약 고정
**파일**: `packages/types/src/index.ts:929-935, 1040-1072`, `docs/compatibility-matrix.md`
**변경사항**: "배치+signal → 항목별 invoke 폴백" 계약 테스트 고정. typed(tier1) 취소 전파 조건 평가 후 확장 또는 문서 고정(구현 비용 대비 판단은 구현 중 결정하되 둘 중 하나로 폐쇄).

#### 4.10 패키지 README 2종
**파일**: `packages/testing/README.md`, `packages/devtools/README.md` (신규)
**변경사항**: createMockEngine/contract-gate, createInstrumentedEngine 사용법.

### 성공 기준:

#### 자동 검증:
- [ ] `npm run test:packages` green (신규 테스트 포함)
- [ ] `npm run test:ts:node` green (코드젠 산출물 변경 반영)
- [ ] `npm run test:adapter:react-native` green (byId 배치 활성화 후)
- [ ] `npm run lint && npm run format:check` green

---

## Phase 5: 이벤트·비동기 스토리 (WS5+WS6)

### 개요

남은 두 개의 구조적 갭을 개통한다. 이벤트(표면 개통 + 코드젠)와 비동기(워커 풀 + persistent transport)다.

### 필요한 변경사항:

#### 5.1 Tauri 이벤트 구독 API
**파일**: `packages/tauri/src/index.ts`, `docs/extending/transport-guide.md`
**변경사항**: `subscribeEvent(name, cb)` — `@tauri-apps/api` `listen("rustra://{name}")` 래핑, unsubscribe 반환. Rust측 `register_with_events`와 짝. 테스트: mock listen으로 구독 해지/전파 검증.

#### 5.2 Node 이벤트 전파
**파일**: `packages/node/src/index.ts`, `examples/calculator/src/bin/` (루프 런타임)
**변경사항**: 루프형 stdio 런타임 bin 추가(기존 run_invoke_stdio는 유지). persistent transport(5.4)가 런타임의 drainEvents 폴링으로 이벤트를 onEvent로 전파.

#### 5.3 이벤트 계약 코드젠
**파일**: `crates/rustra/src/codegen.rs`, `packages/cli/src/generate.ts`, schema.json 형식
**변경사항**: `#[command]`와 유사한 `#[event]` 매크로(또는 빌더 `.event(name, payload_type)`)로 이벤트 정의 → schema.json `events` 섹션 → TS 이벤트 타입 + `subscribeEvent` 헬퍼 생성. dual-path 재생성. RN/tauri/node 3표면 매트릭스 갱신.
- 하위 호환: 기존 schema.json에 events 없으면 산출물 변화 없음.

#### 5.4 워커 풀 + bounded channel
**파일**: `crates/rustra/src/ffi.rs:646-699`
**변경사항**: 호출당 spawn을 lazy 초기화 고정 풀(예: 2~4 스레드) + bounded channel로 교체. 큐 가득 시 즉시 `invoke.failed`/신규 `invoke.backpressure` 에러 프레임. 풀 크기는 상수 + 문서.

#### 5.5 block_on waker 기반 + state 제약
**파일**: `crates/rustra/src/executor.rs:21-32`, `state.rs:60-85`
**변경사항**: park 대신 waker/no-op wake 재호출 구조 검토(타입 제약상 불가하면 현재 구조 유지 + 제약 문서화). thread_local state 유실 제약을 rust-api-guide에 문서화.

#### 5.6 Node persistent transport
**파일**: `packages/node/src/index.ts:79-203`, `examples/calculator/src/bin/loop-stdio.rs` (신규)
**변경사항**: `createNodeLoopTransport` — persistent 프로세스, NDJSON 라인 파서, 요청 id 상관, 배관 dispose 안전(마지막 child만 죽이는 버그 수정), 이벤트 폴링(5.2). 기존 lazy-respawn transport는 deprecated 아님, 병행 유지 + 문서 권장 전환. Rust 예제에 대응 bin 추가.

### 성공 기준:

#### 자동 검증:
- [ ] `cargo test -p rustra` green (워커 풀/백프레셔 테스트 포함)
- [ ] `npm run test:packages` green (tauri/node 신규 테스트)
- [ ] `npm run test:ts:node` green (이벤트 코드젠 산출물)
- [ ] 코드젠 dual-path 재생성 후 산출물 일치 (메모리 관례)
- [ ] `npm run test:runtime:node` green (루프 런타임 경유)
- [ ] 백프레셔: 동시 버스트 테스트에서 에러 프레임 관측

#### 수동 검증:
- [ ] Tauri 샘플에서 이벤트 수신 확인 (bun 어댑터 스모크)

---

## Phase 6: CI·인프라·문서·시장 (WS7)

### 개요

발견성·게이트 사각지대·문서 정합을 정리한다.

### 필요한 변경사항:

#### 6.1 CI 확장
**파일**: `.github/workflows/ci.yml`, `bench.yml`, `.github/dependabot.yml`
**변경사항**: MSRV 1.87 레그(rust 매트릭스에 toolchain 추가), napi 잡(test:runtime:node-napi), windows-latest에 node/bun 런타임 게이트 확장, audit cron 주간, dependabot github-actions 생태계, consumer-smoke 10종 확장, bench paths에 JSI/cli 추가 + criterion baseline 복원 스텝.

#### 6.2 miri + fuzz 정리
**파일**: `.github/workflows/` (miri.yml 신규), `fuzz/`
**변경사항**: 주간 miri 잡(FFI 테스트 skip 설정). fuzz 시드 corpus(축소본) git 등록, 고아 corpus 정리, fuzz 타깃에 invoke_json_into 추가.

#### 6.3 cargo-deny + 커뮤니티 파일
**파일**: `deny.toml` (신규), `.github/SECURITY.md`, `CODEOWNERS`, `ISSUE_TEMPLATE/`, `PULL_REQUEST_TEMPLATE.md`
**변경사항**: deny.toml(라이선스 허용 목록 MIT/Apache-2.0/BSD/ISC/Unicode, duplicates 경고). CI에 `cargo deny check` 잡. 커뮤니티 파일 4종 작성.

#### 6.4 README/문서 대개편
**파일**: `README.md`, `docs/README.md`, `docs/extending/react-native-setup.md`, `docs/benchmarks.md`
**변경사항**: 배지 4종(CI/audit/crates/npm), 경쟁 비교표(napi-rs/Nitro/tauri-specta 대비), 로드맵, FAQ, 영어 Quick Start 섹션(또는 README.en.md + 상단 언어 링크). 색인 4종 추가. RN Android 셋업 재작성(실제 Stable 상태). benchmarks 헤더/수치 정비.

#### 6.5 crates.io/GitHub 메타데이터
**파일**: `Cargo.toml` (keywords, categories, homepage, documentation), `gh repo edit` (topics, description)
**변경사항**: keywords [bridge, typescript, codegen, react-native, tauri], categories ["api-bindings", "development-tools::ffi"], repository topics/description 설정(gh api).

#### 6.6 나머지 문서/인프라
**파일**: `examples/reference-app/`(README + 독립 실행), `packages/*/typedoc.json`(또는 루트 설정), `thoughts/shared/plans/2026-08-20_unimplemented-closure-impl.md`(체크박스 폐쇄)
**변경사항**: reference-app README + crud 의존 해소(로컬 generated 사본 또는 빌드 스텝). typedoc 설정 + `docs:api` 스크립트(게시는 CI 잡 추가까지만). 플랜 체크박스 실제 상태로 폐쇄(구현 확인된 항목 체크 + 근거 각주).

### 성공 기준:

#### 자동 검증:
- [ ] `cargo deny check` 로컬 green
- [ ] CI 전 잡 green (MSRV/napi/windows 포함 — 푸시 후 확인)
- [ ] `npm run test` 전체 green
- [ ] actionlint 또는 YAML 파스 검증 (수동 1회)

#### 수동 검증:
- [ ] README 렌더링 확인 (배지/비교표/언어 링크)
- [ ] gh repo view topics/description 반영 확인
- [ ] reference-app 독립 실행 확인

---

## 테스트 전략

### 단위 테스트:
- Rust: capability freeze/grant 재조정, probe 1회 실행(카운터 핸들러), spawn 가드, $ref 재검증, 워커 풀 백프레셔, 이벤트 코드젠 직렬화
- TS: minify 식별 규약, signal 정책(node/bun/tauri), mock 엔진 배치/옵션, ErrorCode 상수, Writer 정확성(대형 문자열), useCommand 경쟁, positional facade 산출물

### 통합 테스트:
- `test:ts:node` (코드젠 산출물 와이어 라운드트립)
- `test:runtime:node` (루프 런타임 + persistent transport + 이벤트 전파)
- `test:adapter:react-native` (byId 배치)
- `test:compat` 전체

### 수동 테스트 단계:
1. Tauri 어댑터 스모크에서 이벤트 수신
2. README 퀵스타트를 신규 디렉토리에서 복붙 실행
3. 벤치 실행으로 p99/stddev 출력 확인

## 성능 고려사항

- Arc<Value>/단일 조회/caller-buffer는 tier_compare 벤치로 전후 기록 (수치 목표 없음, 회귀 방지만)
- 워커 풀은 동시성 테스트에서 데드락 없음 확인 (타임아웃 가드)
- Writer 개선은 대형 페이로드(100KB 문자열) 인코딩 시간 측정으로 검증

## 마이그레이션 참고사항

- signal 정책 변경(node/bun이 options 수신)은 마이너 체인지 — 기존 2-인수 호출은 전부 호환
- 워커 풀/프로브 변경은 FFI 내부 — JS 인터페이스 불변
- 이벤트 코드젠은 schema.json에 events 선택 섹션 — 기존 산출물 불변
- 새 transport는 병행 추가 — 기존 createNodeProcessTransport 유지

## 참고 자료

- SPEC 문서: `thoughts/shared/specs/2026-08-21_growth-closure.md`
- 리서치 문서: `thoughts/shared/research/2026-08-21_18-50-00_growth-opportunities-survey.md`
- 성능 설계: `docs/plans/2026-08-18-perf-close-nitro-gap.md`
- 코드젠 관례: 메모리 `codegen-dual-path-regen`
- 커밋 관례: 메모리 `lefthook-prettier-amend`
