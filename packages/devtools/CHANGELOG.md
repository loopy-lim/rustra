# @rustra/devtools

## 0.4.0

### Minor Changes

- Node, Bun, Tauri, React Native와 Expo의 생성 진입점이 lazy zero-config bootstrap을
  소유하며, 전용 byte-buffer 경로와 모든 Rustra 패키지의 0.4 lockstep release를 제공합니다.

### Patch Changes

- Updated dependencies
  - @rustra/types@0.4.0

## 0.3.0

### Minor Changes

- 48a0b01: feat: 성장 건덕지 전수 구현 — 결함 수리·이벤트 계약·비동기 풀·루프 런타임·관측성

  **결함 수리 (6건)**
  - release 빌드에서 `grant_capability`가 동작 — freeze는 레지스트리 구조
    mutation에만 적용, 런타임 권한 부여는 동결 무관
  - `#[command(capability = "...")]` 매크로 속성 — 문자열 이름 재결합 없이
    컴파일 타임 권한 지정 (`require_capability_if`)
  - `useCommand`/`useMutation`/`mock()` minify-안전 식별 — 코드젠이
    `commandId` 프로퍼티를 심고 `resolveCommandId()`가 우선 읽는다
  - JSON 엔진(Node/Bun/Tauri) signal 정책 통일 — 미abort signal 정상 실행
    (얕은 취소), abort 시에만 `cancelled`
  - devtools instrumented 엔진이 options(signal/timeoutMs)를 보존
  - `RustraErrorCode` 상수 레지스트리 (19종) + `isRustraErrorCode` 가드

  **이벤트 계약 (양방향 타입 안전)**
  - Rust `PackageBuilder::event::<E>("name")` → schema.json `events` 섹션
  - TS 코드젠이 `events.ts` 생성 — 페이로드 타입 + `RustraEventName` 유니언 +
    `onRustraEvent` 타입 안전 구독 헬퍼 (dual-path 정합)
  - `@rustra/tauri` `subscribeEvent`/`rustraEventChannel` — Rust
    `register_with_events` 와 짝 (과거 JS 구독 API 부재)

  **비동기·런타임**
  - async invoke 3종 엔트리가 고정 워커 풀(2워커/256큐)로 — 호출당
    `thread::spawn` 제거, 풀 가득 시 `invoke.backpressure` 즉시 거부
  - caller-buffer probe 캐시 — 비멱등 핸들러의 사이드 이펙트 2회 실행 방지
  - `rustra_ffi_invoke_rkyv_v2[_into][_async]` 코어 심볼 — 소비자별 복제
    래퍼 제거 (calculator 예제가 위임으로 전환)
  - Node `createNodeLoopTransport` + Rust 루프형 stdio 런타임(`loop-stdio`
    bin) — persistent 프로세스 + NDJSON id 상관 + 이벤트 drain
  - rkyv V2 caller-buffer(`_into`) 심볼 — JSI fast path의 malloc→memcpy→free
    사이클 제거 경로

  **성능**
  - `Command` 스키마 `Arc<Value>`화 — 매 invoke 스키마 deep copy 제거
  - `id_to_command` 직접 캐시 — rkyv V2 디스패치 이중 HashMap 조회 제거
  - napi `rustraInvokeBuffer` — String UTF-16 이중 복사 회피
  - `_utf8Encode` TextEncoder 폴백 계층 + 사전 크기 추정 Writer
  - 벤치 통계 정밀화(트림드 평균/stddev/p99) + 할당 카운팅/콜드스타트 측정

  **코어 안전성**
  - `$ref` 지원 판정이 definitions까지 재귀 검증 (와이어 불일치 방지)
  - async spawn 실패 패닉 가드 + payload 게이트 복사 전 선검사
  - 패닉 에러 메시지 포맷 경로 전체 단일화
  - 이벤트 emit 직렬화 실패 경고, rkyv V2 에러 잘림 마커

  **패키지 완결**
  - mock 엔진: options 기록/pre-aborted `cancelled`/`invokeBatch` 라우팅/`reset`
  - `expectContractCurrent` expect-스타일 계약 게이트 (러너 무관)
  - `RustraJSINative` 타입 3중 수동 미러링 → `RkyvV2SchemaNative` 상속 단일화
  - positional facade `invokeTypedById` 우선 진입 + options 파라미터
  - `@rustra/testing`·`@rustra/devtools` README

### Patch Changes

- Updated dependencies [48a0b01]
  - @rustra/types@0.3.1

## 0.2.1

### Patch Changes

- f77c2b8: chore(meta): npm 패키지 메타데이터 위생 정리 — sideEffects/engines 및 배포 산출물에서 테스트 파일 제외
- Updated dependencies [f77c2b8]
- Updated dependencies [f77c2b8]
  - @rustra/types@0.3.0

## 0.2.0

### Minor Changes

- ecbe69c: Lynx support removed: `@rustra/lynx` is deprecated on npm and the Lynx examples/runner template are deleted from the repo. rustra now targets Node, Bun, Tauri, and React Native. The rkyv V2 binary fast-path is unaffected (shared with the React Native JSI adapter).

### Patch Changes

- Updated dependencies [ecbe69c]
- Updated dependencies [5935b0a]
  - @rustra/types@0.2.0

## 0.1.3

### Patch Changes

- 5002b07: #### Added
  - `@rustra/react` — hooks 패키지 첫 공개 (`useEngine`/`useCommand`/`useEvent`).
  - Rust → JS 이벤트 푸시: `Package::set_event_sink`/`EventSink`(즉시 콜백, 폴링 불필요),
    `tauri_support::register_with_events`(Tauri `rustra://{event}` 푸시),
    FFI `rustra_ffi_event_sink_register`(C-unwind ABI, 패닉 격리),
    RN JSI `onEvent`/`offEvent`(CallInvoker drain, 1024 drop-oldest 큐) +
    `@rustra/react-native` `subscribeEvent` 래퍼.
  - `@rustra/testing` — `createMockEngine`(계약 동일 mock + 호출 기록) / `assertContractCurrent`.
  - `@rustra/devtools` — `createInstrumentedEngine` 관측성 래퍼.
  - `rustra dev` — Rust 소스 감시 hot codegen, `rustra init` — 프로젝트 스캐폴딩,
    Vite 코드젠 플러그인.
  - codegen: `Set<T>` 지원(`BTreeSet`/`HashSet` → `uniqueItems`), 스키마 doc 주석 →
    JSDoc 전파, `RustraCommandError.retryable`, `createAsyncEngine`(async offload).
  - Rust 코어: `State`/`executor` 모듈, rkyv V2 에러 와이어 파싱 공유 헬퍼.

  #### Changed
  - RN JSI fast path 최적화 4종 — 네이티브 함수를 HostObject 스캔 대신 평평한 JS
    객체로 설치, ArrayBuffer ctor 캐시, `invokeTypedById`/`invokeTypedBatchById`
    cmd_id 진입점. Nitro 격차 2.8x → 1.3x (docs/benchmarks.md).

  #### Fixed
  - FFI free 계약 정리(free 짝 누락 경로) + JSI 에러 와이어 postcard 파싱.
  - Tier3 응답 디코드 견고화 + `subscribeEvent` 리스너 풀 정리.
  - RN Android Release 빌드 — Gradle이 Rust 정적 라이브러리를 자동 빌드, nitro-bench
    codegen DEX 충돌 해소로 클린 체크아웃에서 `assembleRelease` 성공.
  - `npm run test:compat` 완전 통과 (bun test 러너 spawnSync 호환 스킵 + Node 경로에
    transport-bench/runtime-contract 포함).

- Updated dependencies [5002b07]
  - @rustra/types@0.1.3
