[English](./safety-contract.md)

# rustra FFI 안전 계약 (Safety Contract)

상태: active · 제정 2026-09-11 · 변경 규칙은 마지막 절 ["이 문서가 바뀌면"](#이-문서가-바뀌면) 참조.

## 1. 총괄 불변식

호스트(외래 foreign) 코드가 rustra 의 Rust FFI 를 **악의적으로, 계약을 어겨서** 호출하더라도
호스트 프로세스에 미정의 동작(UB)이 생겨서는 안 된다. rustra 는 이 총괄 불변식을 세 개의
기계 장치로 방어한다: (a) Rust 패닉은 `catch_unwind` 로 가두어 언제나 정규화된 에러 프레임으로
변환되고 절대 `extern "C"` 경계를 넘지 않는다, (b) 반대 방향 — 외래 예외가 Rust 프레임을
통과하는 것은 잡을 수 없으므로 계약상 즉시 abort 로 정의한다, (c) 그 밖의 모든 비정상 입력
(과대 페이로드, 잘린 프레임, 잘못된 해제 요청, 호스트 콜백 패닉)은 정의된 에러 봉투나
loud abort 로 **fail-closed** 수렴한다 — 조용한 타협은 없다. 실패는 항상 관찰 가능한 형태
(에러 코드, stderr 진단, 게이트 거부)로 나타난다.

## 2. 항목별 계약

### S1. 패닉은 FFI 경계를 넘지 않는다

- **불변식**: FFI 엔트리에서 실행되는 모든 Rust 코드(핸들러, 직렬화, 이벤트 전달, 스왑)가
  패닉하면 그 unwind 는 `catch_unwind` 로 포착되어 `ok:false` 에러 프레임으로 정규화된다.
  패닉 메시지는 단일 포맷 `internal: panic — <payload>` 으로 직렬화된다 — 호스트 파서가
  prefix 로 분류하므로 포맷이 경로별로 갈라지면 안 된다.
- **근거 코드**: `crates/rustra/src/ffi_dispatch.rs:29-48` (`with_panic_guard` —
  `catch_unwind(AssertUnwindSafe)` → `FfiResponse { ok:false }`),
  `crates/rustra/src/ffi_buffer_entries.rs:34-40` (`panic_frame_message` — 단일 포맷),
  `crates/rustra/src/ffi_buffer_entries.rs:12-18` (caller-buffer 경로의 동일 가드),
  `crates/rustra/src/ffi_typed_buffer.rs:67,103` (Frame 버퍼 경로 → `RustraError::internal`),
  `crates/rustra/src/ffi_event_entries.rs:44,77` (이벤트 싱크 등록/해제 경로).
- **위반 시 동작**: 호스트는 정상 반환된 에러 프레임(`internal: panic — …`)을 받는다.
  프로세스 상태는 보존된다 — 패닉 하나로 호스트가 죽지 않는다.
- **검증 위치**: `crates/rustra/tests/trust_baseline_ffi.rs:609,613` (panic 프레임 prefix 단언),
  `crates/rustra/tests/payload_robustness.rs` (비정상 페이로드가 abort/panic 없이 clean
  `RustraError` 로 수렴), `crates/rustra/src/events_tests.rs:88`
  (`panicking_sink_does_not_propagate`), `crates/rustra/src/ffi_tests.rs:374-385`
  (패닉하는 C 콜백 후 emit 정상 지속).

### S2. 외래 예외는 Rust 프레임을 통과하지 않는다 (abort 계약)

- **불변식**: 호스트 콜백(C/C++ 등)은 Rust 프레임을 거쳐 예외를 되감기(unwind)하지
  않아야 한다. Rust 패닉은 `catch_unwind` 로 격리되지만, Rust 가 호출한 외래 콜백에서
  던져진 **외래 예외**는 Rust 가 잡을 수 없다 — `extern "C"` 하에서는 UB, `"C-unwind"`
  ABI 하에서는 정의된 즉시 abort 다. C++ 호스트 콜백은 `noexcept` 로 표시하거나 최상위
  `catch (...)` 로 삼는 것이 호스트의 의무다.
- **근거 코드**: `crates/rustra/src/ffi_event_entries.rs:20-24` (되감기 금지 계약 문서),
  호스트가 패닉하는 콜백을 넘겨도 rustra 쪽은 `catch_unwind` 로 방어한다
  (`crates/rustra/src/ffi_event_entries.rs:44`, `crates/rustra/src/events_state.rs` 의
  `deliver_via_sink`).
- **위반 시 동작**: 외래 예외가 Rust 프레임을 통과하면 프로세스 abort (정의된 동작 —
  UB 아님). 데이터 손상은 없다.
- **검증 위치**: doc 계약(코드 주석 고정) + `crates/rustra/src/ffi_tests.rs:374-385`
  (`extern "C-unwind"` 패닉 콜백이 emit 을 깨지 않음). 외래 예외 주입 자체는 C++ 테스트
  하니스가 필요해 자동 검증되지 않는다 — 알려진 한계.

### S3. 버퍼 소유권: 8바이트 헤더, 해제 페어링, `usize::MAX` 센티넬

- **불변식**:
  1. `rustra_ffi_invoke*` 계열이 돌려주는 버퍼는 8바이트 헤더를 갖는다 — magic
     `0x52555354` ("RUST") + `u32 LE` payload 길이. 반환 포인터는 헤더 **뒤** payload
     시작점이고, 소유권은 호스트로 이전된다 (boxed slice).
  2. 해제는 반드시 짝이 맞는 함수로 정확히 1회: 헤더 달린 버퍼는 `rustra_ffi_free(ptr, len)`,
     `rustra_ffi_invoke_buffer` 의 헤더 없는 boxed slice 는 `rustra_ffi_free_owned_bytes(ptr, len)`.
     두 함수는 호환되지 않는다. `rustra_ffi_free` 는 magic 을 검증해 외래 포인터·이중 해제를
     거부하고, 해제 전 magic 을 0 으로 무효화한다. debug 빌드에서는 라이브 할당 추적기가
     오남용(WrongAllocator/WrongLen/NotLive)을 감지하면 진단을 남기고 **abort** 한다
     (release 에서는 컴파일 아웃 — 호출자 계약에 의존).
  3. caller-buffer 2단계 프로토콜(probe → write)에서 대상 버퍼가 부족하면 쓰지 않고
     `usize::MAX` 를 반환해 재-probe 을 요구한다 — 부분 쓰기나 트렁케이션은 없다.
- **근거 코드**: `crates/rustra/src/ffi_prelude.rs:94-115` (`FFI_MAGIC`, `alloc_response`),
  `crates/rustra/src/ffi_prelude.rs:120-128` (`alloc_owned_bytes`),
  `crates/rustra/src/ffi_lifecycle_entries.rs:110-146` (`rustra_ffi_free` — magic 검증·무효화·
  debug abort), `crates/rustra/src/ffi_lifecycle_entries.rs:156-173`
  (`rustra_ffi_free_owned_bytes`), `crates/rustra/src/ffi_free_guard.rs` (debug Verdict 분류),
  `crates/rustra/src/ffi_sync_entries.rs:85-133` (`usize::MAX` 재-probe 센티넬),
  `crates/rustra/src/ffi_typed_buffer.rs:19-93` (동일 센티넬).
- **위반 시 동작**: 잘못된 짝·이중 해제 — debug 에서 loud abort, release 에서 magic 불일치
  거부(무해 no-op) 또는 호출자 계약 위반 UB (release guard 는 컴파일 아웃이다 — 문서로
  고정된 호출자 의무).
- **검증 위치**: `crates/rustra/src/ffi_free_guard.rs:76-96` (Verdict 단위 테스트),
  `crates/rustra/tests/trust_baseline_ffi.rs` (왕복 해제), debug 추적기 abort 경로는
  `ffi_free_guard` 테스트가 Verdict 로 고정.

### S4. 페이로드 한도: `max_payload` 게이트

- **불변식**: 인코딩된 요청 페이로드가 동적 한도(기본 1 MiB)를 초과하면 네이티브 핸들러는
  호출되지 않고 `payload.too_large` (non-retryable — 결정론적 클라이언트 조건) 에러 프레임으로
  거부된다. 한도는 런타임에 동적으로 읽는다 (`rustra_ffi_set_max_payload`/`get`). TS 쪽은
  네이티브 호출 **직전**에 같은 코드로 사전 거부한다 (네이티브 동적 한도가 최종 게이트 —
  TS pre-check 는 왕복 절약일 뿐 별도의 계약이 아니다).
- **근거 코드**: `crates/rustra/src/limits.rs:6-20` (기본 1 MiB + 동적 원자 한도),
  `crates/rustra/src/ffi_buffer_entries.rs:4-6,122-125` (Rust 측 게이트 →
  `RustraError::payload_too_large`), `crates/rustra/src/error.rs:127-130` (코드·non-retryable),
  `crates/rustra/src/ffi_lifecycle_entries.rs:80-94` (한도 FFI 심볼),
  `packages/types/src/frame-engine-contract.ts:39-54` (`payloadTooLargeError` TS 사전 게이트).
- **위반 시 동작**: 초과 페이로드는 `payload.too_large: payload NB exceeds max payload MB`
  에러 프레임으로 거부된다 — 핸들러 실행 없음.
- **검증 위치**: `crates/rustra/tests/payload_robustness.rs`, `crates/rustra/src/error_tests.rs:15`
  (non-retryable 고정), `packages/types/src/index.test.ts:2246` (한도 초과 시 네이티브 무호출),
  `packages/react-native/src/index.test.ts:469-490` (pre-check 전달 검증).

### S5. 핫 코어 (experimental): 포이즌, fail-closed 발행, dlclose 금지

- **불변식** (hot-core feature 는 실험 표면이며 계약은 다음 세 가지로 고정된다):
  1. **바이트 단위 포이즌**: 같은 sha256 바이트에 대한 연속 스왑 실패가 상한(5회)에 도달하면
     그 바이트는 포이즌 표시되어 새 바이트가 발행될 때까지 재시도하지 않는다 — 실패 폭주가
     이벤트 폭주·서브프로세스 낭비로 퇴화하지 않는다. 포이즌 판정은 바이트(해시) 단위다 —
     새 바이트는 언제나 새 재시도 창을 갖는다. 스왑 시도 자체는 `catch_unwind` 로 감싸져
     잘못된 아티팩트의 패닉이 감시 스레드를 죽이지 않는다.
  2. **fail-closed 발행**: `rustra dev` 는 parity 게이트를 통과한 빌드만 감시 경로
     `<stem>-hot-live<ext>` 로 원자 발행(tmp 복사 → rename)한다. 게이트 거부 시 reload 신호는
     방출되지 않고 라이브 경로는 건드리지 않는다 — 호스트는 이전 발행물을 계속 실행한다.
  3. **dlclose 금지**: 열린 cdylib 은 절대 언로드하지 않는다 (`Box::leak`으로 `'static` 고정).
     macOS 는 std TLS 때문에 dlclose 가 no-op 이고, Linux 는 구 심볼 포인터가
     use-after-unload 되므로 세션당 버전 카피 1개씩의 매핑 누수를 dev 환경 감수 정책으로
     택한다. 스왑으로 밀려난 구 코어의 drop 은 dlclose 를 일으키지 않는다.
- **근거 코드**: `crates/rustra/src/hot_core_watch.rs:58` (`MAX_SWAP_FAILURES_PER_BYTES = 5`),
  `crates/rustra/src/hot_core_watch.rs:64-99` (`FailureTracker` — 바이트 단위 포이즌),
  `crates/rustra/src/hot_core_watch.rs:147-177` (`attempt_swap` catch_unwind),
  `packages/cli/src/dev.ts:244-316` (게이트 거부 → reload 미방출·라이브 무변경, 통과 시에만
  `publishGatedArtifact`), `packages/cli/src/dev-dylib.ts:191-207` (`-hot-live` 경로 규약),
  `crates/rustra/src/hot_core_dylib.rs:6-13,125` (dlclose 금지·leak 계약),
  `crates/rustra/src/hot_core_dylib.rs:309-330` (macOS ad-hoc 재서명 — 실패는 loud 전파).
- **위반 시 동작**: 포이즌 상태의 바이트는 조용히 대기(로그 1회), 새 바이트에 재개. 게이트
  거부 빌드는 cargo 타깃 경로에 머문다. 언로드를 시도하는 경로는 존재하지 않는다(타입이
  `'static`).
- **검증 위치**: `crates/rustra/src/hot_core_tests.rs:57-97` (포이즌 캡·새 바이트 재개),
  `packages/cli/src/dev-parity-wiring.test.ts:569+` (게이트 통과 발행만 라이브 경로로),
  `examples/hot-core-probe` (단독 검증기 — 호스트/iOS 시뮬레이터/Android 에뮬레이터).

### S6. 에러 봉투(envelope)는 항상 같은 모양으로 수렴한다

- **불변식**: FFI 응답은 경로와 무관하게 정의된 봉투 중 하나로 직렬화된다 — JSON
  `{"ok":bool,"result":...,"error":string|null}`, postcard `FfiPostcardResponse`
  (`result_json`/`error` 는 JSON 문자열 임베드), Frame 은
  `[ok][pad][len u16][postcard {code, message}]` 프레이밍(에러는 `ok=0`, payload 필드 없음).
  JSON fallback 은 Rust `Display` 문자열을 첫 `": "` 기준으로 `{code, message}` 재분할한다.
  직렬화조차 실패하면 하드코딩된 최소 에러 바이트로 수렴한다 — 응답 없음이 없다.
- **근거 코드**: `crates/rustra/src/ffi_prelude.rs:60-81` (`FfiResponse`,
  `FfiPostcardResponse`), `crates/rustra/src/ffi_dispatch.rs:74-77` (JSON 인코딩 실패 fallback),
  `crates/rustra/src/hot_core_dylib.rs:223-228` (`split_error_wire` — Display 재분할), 프레이밍 계약은
  `docs/wire-format.md:84-94`, 코드 체계는 `crates/rustra/src/error.rs:23` 표 +
  `packages/types/src/errors.ts:156`.
- **위반 시 동작**: 디코드 불가 프레임은 호스트에서 `invoke.failed` 로 정규화된다
  (`crates/rustra/src/hot_core_dylib.rs:159-175`, `packages/types/src/frame-engine-contract.ts:12-34`
  `tier2Outcome` — codec throw 도 reject 로 수렴, 프라미스 미정찰 없음).
- **검증 위치**: `crates/rustra/tests/trust_baseline_ffi.rs` (3코너 pinned hex),
  `docs/wire-format.md` (바이트 계약 문서), `packages/types/src/index.test.ts` (에러 코드
  파싱·재분할).

### S7. fail-closed 게이트 철학

- **불변식**: "계약을 검증할 수 없으면 계약이 없는 것과 같다" — 검증 장치는 의심 상태에서
  통과하지 않는다. (a) 런타임 계약 검증: 소비자가 `contractHash` 를 넘기면 네이티브 해시와
  다를 때 `contract.mismatch` 로 fail-fast (네이티브가 해시를 아예 못 주면
  `contract.unenforceable` — 콜백으로도 우회 불가). (b) dev parity 게이트: wasm/dylib 타깃은
  기본 켜지고, 게이트가 거부하면 reload 자체가 방출되지 않는다 (호스트는 기존 엔진 유지).
  (c) Android 핫 코어 감시는 `FLAG_DEBUGGABLE` 빌드에서만 활성화 — 릴리스 빌드에는 감시
  스레드 자체가 존재하지 않는다. (d) `scripts/docs-gate.mjs` 는 마커 규약 위반·드리프트를
  fail-closed 로 모아 보고하고, ko 미러 완전성도 게이트가 강제한다.
- **근거 코드**: `packages/types/src/frame-engine-contract.ts:61-163`
  (`validateFrameEngineOptions` — mismatch/unenforceable), `packages/cli/src/dev.ts:233-330`
  (parity 게이트 fail-closed 발행), Android 게이트:
  `examples/react-native-calculator/modules/rustra-jsi/android/src/main/java/dev/rustra/bridge/RustraBridgeModule.kt:35`
  (iOS 는 `RUSTRA_HOT_CORE_DIR` env 게이트와 대칭), `scripts/docs-gate.mjs`.
- **위반 시 동작**: 게이트는 통과 대신 실패를 낸다 — 엔진 생성 거부, reload 미방출,
  CI exit 1. "검증 스킵 후 진행"은 존재하지 않는다.
- **검증 위치**: `packages/types/src/index.test.ts` (mismatch/unenforceable 경로),
  `packages/cli/src/dev-parity-wiring.test.ts`, `scripts/docs-gate.test.ts`.

## 이 문서가 바뀌면

이 계약의 어떤 항목(S1–S7 포함 총괄 불변식)이라도 의미가 바뀌면 — 강화, 약화, 해석 변경
모두 — **새 ADR 을 `docs/adr/` 에 작성해야 한다** (형식은 `docs/adr/README.md` 참조).
코드가 이 문서와 갈라지면 버그다: 문서를 현실에 맞추는 커밋이라도 계약 변경이면 ADR 로
기록한다. 근거 코드 경로의 **줄 번호 이동**(같은 계약, 다른 줄)은 ADR 없이 갱신할 수 있다.
