# @rustra/cli

## 0.6.0

### Minor Changes

- 8266d23: Three parallel tracks landed together.

  **Events surface complete**: `subscribeEvent` now exists on every host — Node (`drainEvents` polling adapter), Bun (`createBunEventBridge`: FFI push sink with polling fallback), joining Tauri and React Native. Signatures are pinned to the codegen `SubscribeFn` contract by compile-time probes.

  **Performance five tracks**: complex-route core dispatch stops rebuilding `serde_json::Value` trees three times per call (schema IR precompilation + direct serde), dynamic commands gain a `schema_generation` replacement contract and a postcard fast-path (472–488 ns vs 4.7 µs Tier 3), the Node persistent loop speaks binary framing, Tauri gets batched `rustra_dispatch_batch` and corrected IPC measurements (246 µs with a 709 ns native component), and RN async dispatch enters by command id.

  **Developer experience**: the CLI has one shared arg parser (`--help`, exit codes, `--flag=value`, "did you mean" suggestions), refuses to overwrite existing files on `init` without `--force`, fails loudly on unknown config keys, and reports codegen `unknown` fallbacks as warnings. `RUSTRA_DEBUG=wire` dumps wire bytes; errors preserve `cause` and distinguish `TimeoutError`/`CancelledError`. Six documentation examples that failed to compile or run were corrected, and the changelog covers 0.3 → 0.5.

  `@rustra/types` is minor. Packages keep independent release lines: prior 0.5.x packages move to 0.6.0 and prior 0.4.x packages move to 0.5.0; adapter ranges now require `^0.6.0`.

  Rust crates (`rustra`, `rustra-macros`): schema generation contract for hot-replace sync, dynamic-command postcard handlers, Tauri `rustra_dispatch_batch`, precompiled complex-codec IR, direct serde encoding, and codegen warning collection surfaced on `GeneratedPackage.warnings`.

### Patch Changes

- Updated dependencies [8266d23]
  - @rustra/types@0.6.0

## 0.5.0

### Minor Changes

- 6deb659: feat: C++ Set 직결 — 원시 요소 Set의 네이티브 encode

  - `cppComplexNativeSupported` 가 `sequence.uniqueItems` 를 원시 요소
    (string/number/integer/bool, literal/enum 포함)에 한해 허용한다. 객체/배열
    요소 Set 은 IR 정규화 한계로 계속 JS complex 경로를 탄다.
  - C++ complex encode: JS Set 을 `instanceof Set` 판별 후 `Array.from(set)` 으로
    이터레이션 순서 보존 복사([...set] 계약 — TS complex-codec.ts 와 동일,
    **정렬/중복제거 없음**)한 뒤 postcard seq 를 쓴다. 배열 입력도 허용한다.
  - C++ complex decode: 전역 `Set` 생성자에 `callAsConstructor` 로 요소 배열을
    넘겨 실제 JS `Set` 을 복원한다(new Set(values) 계약 — 중복은 Set 이 정리).
  - example: calculator 에 `tagSet`(BTreeSet<i64> 입력 / BTreeSet<String> 출력,
    commandId 29) 추가. 신규 command 는 기존 id 를 보존하기 위해 등록 순서 맨
    뒤에 추가해야 한다 — register! 튜플은 `.command_fn` 체인만 생성하므로
    builder 체인(.buffer_command_fn/.command_fn) 명령보다 **앞에** 올 수 없고,
    체인 끝에 `.command_fn` 으로 붙인다(초기 구현이 register! 튜플에 넣어
    benchEchoBytes/Pair/echoGroups id 를 시프트한 것을 수정 — generated id 는
    원래 값 25/26/27 유지). 양쪽 생성물(Rust bin + TS CLI)을 함께 재생성할 것.
  - wire fixture: `TAGSET_REQUEST/RESPONSE` PINNED hex (Rust wire_fixtures.rs ↔
    TS cross-wire.test.ts ↔ C++ test-rustra-generated-codecs.cpp 3면 동일).
    와이어 자체는 순서 보존 postcard seq 로 기존과 동일 — BTreeSet 은 정렬 순서로
    직렬화되고 Set 복원 후 순서는 관측되지 않는다.
  - test-jsi-shim: Function/global()/instanceOf/getPropertyAsFunction 최소 표면
    추가 — Set 직결 경로를 독립 C++ 테스트에서 검증한다.

- 6deb659: feat: bigint postcard fast-path — 와이드 정수 게이트 해제

  **와이어 변경 (breaking for stale codecs)**

  - `int64`/`uint64` 필드가 complex codec 폴백 대신 postcard fast-path 로 라우팅
    됩니다(A1의 64-bit `_pcEncodeVarint64`/`_pcDecodeVarint64`/`_pcEncodeZigzag64`/
    `_pcDecodeZigzag64` 헬퍼 사용). Rust 엔진 게이트도 동일 판정으로 갱신되어
    양면 와이어가 일치합니다.
  - **튜플/와이드 정수 명령의 와이어가 0.4.1 과 다릅니다.** 예: calculator
    `span` — 0.4.1 complex-codec 튜플 와이어는 `count + elements` 였지만 postcard
    튜플은 접두 없는 `elements` 나열입니다. 0.4.1 TS 코덱과 재생성된 Rust(또는
    그 역)를 혼용하면 디코딩이 조용히 깨집니다 — 양쪽을 함께 재생성해야 합니다.
  - safe 정수 범위(±2^53) 밖의 값은 `number` 대신 `bigint` 로 복원됩니다.
    TS 타입 표면이 `i64`/`u64` 필드에서 `number` → `number | bigint` 로 넓어집니다.
  - 복합 타입도 와이드 정수를 수용: `Vec<u64>`, `HashMap<String, u64>`,
    `Option<i64>` 등이 원소/값 레벨 64-bit 헬퍼로 fast-path 를 사용합니다
    (`vec_i64/vec_u64`, `map_i64/map_u64`,
    `option_zigzag64/option_uvar64` kind 신설). 단 `Set<T>` 는 이번에도
    complex 라우트를 유지합니다 — 명령 단위 게이트(`hasSet`)가 uniqueItems 를
    배제하므로 `set_i64/set_u64` kind 는 현 게이트에서는 도달하지 않는
    준비물입니다(C++ Set 직결은 별도 changeset 참조).
  - C++ 정적 코덱(JSI 네이티브)은 여전히 int64/uint64 를 fast-path 에 넣지
    않습니다 — 해당 필드가 있으면 C++ 광고 집합에서 제외됩니다(트랙 B 후속).
  - 경계 와이어 픽스처: calculator `gauge`(u64::MAX), `span`(i64::MIN, 2^53±1),
    신규 `wideAgg`(Vec<u64> + Option<i64> 다원소 10바이트 LEB128) — Rust
    `wire_fixtures.rs` 와 TS `cross-wire.test.ts` 가 동일 hex 를 공유합니다.

### Patch Changes

- Updated dependencies [6deb659]
  - @rustra/types@0.5.0

## 0.4.1

### Patch Changes

- Keep React Native generated native paths valid for hoisted npm/Bun workspaces and verify that published adapter tarballs contain the Android, iOS, and C++ bridge sources.
- Allow the CLI template and release validation to use compatible Rust and types versions independently from the CLI package version.
- Updated dependencies
  - @rustra/types@0.4.1

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
- f77c2b8: feat: InvokeOptions.timeoutMs — 네이티브 무응답 hang의 JS 측 탈출구. 만료 시 `transport.timeout`(retryable)으로 reject 하고 지각 응답은 흡수한다(unhandled rejection 방지).

  fix: 스키마 식별자 화이트리스트로 생성 TS 코드 주입 방어(name/inputType/outputType/definitions 키). napi 경로 RustraError를 JSON 와이어로 보존 — code/retryable이 소실 없이 JS까지 전달된다(기존 unknown 래핑 개선).

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
