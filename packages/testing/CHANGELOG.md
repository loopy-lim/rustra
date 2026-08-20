# @rustra/testing

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
