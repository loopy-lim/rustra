# @rustra/tauri

## 0.2.0

### Minor Changes

- ecbe69c: Lynx support removed: `@rustra/lynx` is deprecated on npm and the Lynx examples/runner template are deleted from the repo. rustra now targets Node, Bun, Tauri, and React Native. The rkyv V2 binary fast-path is unaffected (shared with the React Native JSI adapter).
- 5935b0a: #### Codegen correctness (fix)
  - The rkyv postcard codec no longer silently drops unsupported fields (`Option<T>`, `Vec<String>`, `Vec<Struct>`, string enums) from generated codecs — the crud example's `updateItem`/`getItem`/`listItems` wire frames were silently truncated. All four shapes now encode/decode correctly, verified by byte-exact round-trip tests against an independent postcard implementation.
  - Commands with genuinely unsupported field types (maps, data-carrying enums) are excluded from the rkyv registry and the C++ `has_static_codec` dispatch with a `WARN` at generation time; the engine routes them through the Tier 3 JSON-in-binary fallback. Rust mirrors the same support set (`js_postcard_codec_supported`) so both sides agree on the wire — no more partial-codec preemption.
  - `allOf` maps to `A & B` intersections and integer enums map to `1 | 2 | 3` literal unions in both the Rust codegen and the TS CLI (dual-path parity).
  - Field-order drift warning: when schema properties appear alphabetically sorted, `rustra generate` warns that postcard requires declaration order (preserve_order).
  - `rustra init` templates reference `^0.1.3` (was pinned to `^0.1.1`).

  #### Cancellation & semantics
  - AbortSignal propagation now reaches the Rust checkpoint on typed (tier 1) and Tier 3 dynamic commands when the native module exposes `invokeAsync`/`invokeCancel` — previously only JS-codec (tier 2) commands propagated. Commands without a commandId source keep shallow cancel.
  - `getLiveSchema` throws `schema.unavailable` when the native module does not expose `getSchema` (was: silent empty Map). Engine dispatch absorbs this and preserves the `command.not_found` contract.
  - JSON transports (Node/Bun/Tauri engines) no longer silently ignore `options.signal`: pre-abort rejects with `cancelled`, in-flight rejects with `cancel.unsupported`.
  - `invokeBatch` single-traversal cancel semantics documented as an explicit contract (signal-bearing entries route per-item).

  #### Onboarding / DX
  - `createNodeProcessTransport` in `@rustra/node`: subprocess transport speaking the standard `<bin> invoke` stdio JSON protocol — the getting-started Node quickstart is now copy-paste complete. The crud example ships the same `invoke` entrypoint as the calculator.
  - New `docs/compatibility-matrix.md`: signal/cancel/batch/events × adapter support table.
  - New `examples/reference-app`: a React app using `@rustra/react` hooks (`useCommand`/`useMutation`/`useEvent`/`RustraProvider`) over the crud package, with a runnable smoke (`npm run test:app:reference`).

  #### Performance follow-ups
  - `rustra_ffi_invoke_json_into`: caller-buffer FFI variant eliminating the Rust malloc → copy → caller-memcpy triple copy (size-probe → write two-phase protocol).
  - `rustra generate --positional`: emits `positional-facade.ts` wrapping static commands as positional signatures (`addNumbers(a, b)`) calling JSI `invokeTyped` directly.

  #### Misc
  - RN JSI bridge exposes `getContractHash` — the `contractHash` engine option works on React Native now.
  - `docs/rust-api-guide.md` rewritten to match the real macro contracts (single Input struct required, `Result<O>` required; removed fictional scalar-multi-param/bare-return/`rename_all` override APIs; documented event bus, capability, FFI, freeze, tauri APIs).
  - RSS measurement in the benchmark harness works on Linux (`/proc/self/statm`).

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
