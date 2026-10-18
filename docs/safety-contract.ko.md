[English](./safety-contract.md)

# rustra FFI 안전 계약 (Safety Contract)

상태: active · 제정 2026-09-11 · 변경 규칙은 마지막 절 ["이 문서가 바뀌면"](#이-문서가-바뀌면) 참조.

## 1. 총괄 불변식

호스트가 FFI의 unsafe 메모리·ABI 전제를 지키면 악의적이거나 비정상인 **페이로드
바이트**가 미정의 동작(UB)을 일으켜서는 안 된다. 호출자는 유효하고 정렬이 맞는
읽기·쓰기 범위, 빌린 버퍼와 콜백 상태의 수명, 충돌하지 않는 접근, 소유 응답의
정확한 해제 함수·1회 해제를 보장한다. null은 각 엔트리가 허용한 경우에만 가능하다.
프로세스 내부 unsafe API는 임의 포인터의 출처와 수명을 검증할 수 없으며, 이 전제를
위반하면 UB가 생길 수 있다.

이 경계 안에서 잘못되거나 과대한 입력은 핸들러 실행 전에 거부하고, 가드된 Rust
unwind를 가두며, debug 소유권 검사에서 확인한 오용은 진단과 함께 abort한다.
헤더 magic은 유효한 메모리의 일관성 검사이지 임의 주소의 읽기 가능성을 입증하지
않는다. C++ 콜백은 Rust로 돌아오기 전에 호스트 wrapper 안에서 외래 예외를 처리해야
한다(S2). 자원 고갈과 `panic=abort`는 복구 가능한 에러 프레임 보장 범위가 아니다.
공개 ABI를 유지한 이 경계 정정은 [ADR 0004](adr/0004-ffi-safety-preconditions.ko.md)에 기록한다.

## 2. 항목별 계약

### S1. 보호된 Rust 패닉 경계

- **불변식**: 가드된 명령·직렬화 경로의 Rust unwind는 `catch_unwind`로 포착되어
  `ok:false` 에러 프레임으로 정규화된다. 이벤트 싱크 패닉은 로그를 남기고 이벤트를
  버리며, 반환값 없는 등록 엔트리는 응답 프레임을 돌려줄 수 없다. `panic=unwind`에
  대한 계약이며 `panic=abort`에는 적용되지 않는다.
  패닉 메시지는 단일 포맷 `internal: panic — <payload>` 으로 직렬화된다 — 호스트 파서가
  prefix 로 분류하므로 포맷이 경로별로 갈라지면 안 된다.
- **근거 코드**: `crates/rustra/src/ffi_dispatch.rs:29-48` (`with_panic_guard` —
  `catch_unwind(AssertUnwindSafe)` → `FfiResponse { ok:false }`),
  `crates/rustra/src/ffi_buffer_entries.rs:34-40` (`panic_frame_message` — 단일 포맷),
  `crates/rustra/src/ffi_buffer_entries.rs:12-18` (caller-buffer 경로의 동일 가드),
  `crates/rustra/src/ffi_typed_buffer.rs:67,103` (Frame 버퍼 경로 → `RustraError::internal`),
  `crates/rustra/src/ffi_event_entries.rs:44,77` (이벤트 싱크 등록/해제 경로).
- **위반 시 동작**: 호스트는 정상 반환된 에러 프레임(`internal: panic — …`)을 받는다.
  지원하는 가드 경로는 호출자에게 복귀한다. non-unwind 호스트 콜백에서 발생한
  Rust 패닉이나 abort하는 패닉까지 복구한다는 뜻은 아니다.
- **검증 위치**: `crates/rustra/tests/trust_baseline_ffi.rs:609,613` (panic 프레임 prefix 단언),
  `crates/rustra/tests/payload_robustness.rs` (비정상 페이로드가 abort/panic 없이 clean
  `RustraError` 로 수렴), `crates/rustra/src/events_tests.rs:88`
  (`panicking_sink_does_not_propagate`), `crates/rustra/src/ffi_tests.rs:374-385`
  (패닉하는 C 콜백 후 emit 정상 지속).

### S2. 외래 예외는 호스트 콜백 안에서 처리한다

- **불변식**: C++ 콜백은 Rust로 돌아오기 전에 예외를 잡아야 한다. `noexcept`
  wrapper에서 오류를 기록하고 정상 복귀하거나 복구 불가능하면 `std::abort`를 명시적으로
  호출할 수 있다. 예외를 Rust로 unwind해서는 안 된다. `C-unwind`는 ABI 수준의 unwind를
  허용할 뿐 Rust `catch_unwind`가 외래 예외를 복구하거나 반드시 abort함을 보장하지
  않는다. non-unwind ABI로 들어오는 외래 예외는 UB다. 계약을 강제하는 위치는
  C++ 예외를 Rust가 잡는다는 약속이 아니라 호스트 wrapper다.
- **근거 코드**: `crates/rustra/src/ffi_event_entries.rs`의 콜백 의무,
  [Rust FFI unwind 규칙](https://doc.rust-lang.org/nomicon/ffi.html#ffi-and-unwinding),
  [`catch_unwind` 주의사항](https://doc.rust-lang.org/std/panic/fn.catch_unwind.html#notes).
  Rust 콜백 패닉 격리는 별도 검증이다.
- **위반 시 동작**: 외래 예외가 탈출하면 복구나 정의된 abort를 보장하지 않는다.
  C++ wrapper 안의 명시적 abort는 그 wrapper가 정의한 동작이다.
- **검증 위치**: `bash scripts/run-foreign-exception-check.sh`는 실제 Rust 이벤트 싱크를
  사용하는 C++ 호스트를 빌드한다. 실제 C++ throw를 Rust 복귀 전에 잡으며, 오류 기록 후
  두 번째 이벤트를 받는 경우와 격리한 자식에서 명시 abort해 SIGABRT·진단을 확인하는
  경우를 검사한다. 경계를 넘는 UB를 실행해서 안전하다고 인증하지 않는다.
  macOS/Linux harness이며 모든 언어·ABI·플랫폼 검증을 뜻하지 않는다.

### S3. 버퍼 소유권: 8바이트 헤더, 해제 페어링, `usize::MAX` 센티넬

- **불변식**:
  1. 헤더가 있는 invoke 경로의 소유권 이전 응답은 8바이트 헤더를 갖는다 — magic
     `0x52555354` ("RUST") + `u32 LE` payload 길이. 반환 포인터는 헤더 **뒤** payload
     시작점이고, 소유권은 호스트로 이전된다 (boxed slice).
     호출자 소유 출력 버퍼와 빌린 channel callback 데이터는 이 소유권을 이전하지
     않는다. 호스트는 그 포인터를 소유 응답처럼 해제하면 안 된다.
  2. 해제는 반드시 짝이 맞는 함수로 정확히 1회: 헤더 달린 버퍼는 `rustra_ffi_free(ptr, len)`,
     `rustra_ffi_invoke_buffer` 의 헤더 없는 boxed slice 는 `rustra_ffi_free_owned_bytes(ptr, len)`.
     두 함수는 호환되지 않는다. `rustra_ffi_free`는 유효한 할당의 헤더 magic을
     검사·무효화하고 해제한다. 헤더 읽기부터 유효한 할당 메모리가 전제다. debug 빌드에서는 라이브 할당 추적기가
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
- **위반 시 동작**: 잘못된 짝·길이·비활성 포인터는 debug 추적기가 진단 후 abort한다.
  release에서는 잘못된 포인터·이중 해제가 magic 검사 이전부터 UB일 수 있어 안전한
  no-op을 보장하지 않는다. 유효하고 읽을 수 있는 할당의 magic 불일치는 거부하지만
  출처·수명을 검증한 것은 아니다. 정확한 반환 포인터·길이를 쓰는 의무는 유지된다.
- **검증 위치**: `crates/rustra/src/ffi_free_guard.rs:76-96` (Verdict 단위 테스트),
  `crates/rustra/tests/trust_baseline_ffi.rs` (왕복 해제), `crates/rustra/tests/ffi_process_contract.rs`
  (Unix debug 자식 프로세스에서 두 allocator의 잘못된 길이·짝·이중 해제·외래 포인터에
  대한 실제 abort; 올바른 페어링은 release에서도 검사). release에서 오용은 실행하지 않는다.

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
  `packages/cli/src/dev.ts` `runConfigDev` (게이트 거부 → reload 미방출·라이브 무변경,
  통과 시에만 `publishGatedArtifact`), `packages/cli/src/dev-dylib.ts:191-207` (`-hot-live` 경로 규약),
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
  직렬화 실패에는 하드코딩된 최소 에러 바이트를 사용한다. 이는 총괄 전제 안에서의
  응답 형식 보장이지 호스트 종료 이후 전달까지 보장하지 않는다. 유지한 async channel을
  닫으면 이후 native 전달을 억제하고 Rust가 응답을 해제한다. 호스트는 channel을
  폐기할 때 자신의 대기 작업을 종료해야 한다. scriptc 같은 외부 런타임은 release 전에
  복사해 큐에 넣은 callback을 이후에도 배수할 수 있다. 폐기된 상태에 대한 효과는
  native 등록 해제와 별도로 consumer가 방어해야 한다.
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
  통과하지 않는다. (a) 런타임 계약 검증: 기본 정책(`contractVerification: 'strict'` —
  `undefined` 도 동일 동작)에서 소비자가 `contractHash` 를 넘기면 네이티브 해시와 다를 때
  `contract.mismatch` 로 fail-fast (네이티브가 해시를 아예 못 주면
  `contract.unenforceable` — strict 에서는 콜백으로도 우회 불가). `contractVerification`
  옵션이 유일한 명시적·호출자 소유의 탈출구다: `'warn'` 은 이 실패들을 콘솔 경고로
  강등해 degraded 모드로 계속하고, `'off'` 는 `contractHash` 를 설정했더라도 검증을
  건너뛴다. 이 노브는 네이티브 Frame 엔진 경로에만 적용되고 검증을 스스로 켜지 않는다 —
  `contractHash` 가 없으면 검증할 것이 없다. (b) dev parity 게이트: wasm/dylib 타깃은
  기본 켜지고, 게이트가 거부하면 reload 자체가 방출되지 않는다 (호스트는 기존 엔진 유지).
  (c) Android 핫 코어 감시는 `FLAG_DEBUGGABLE` 빌드에서만 활성화 — 릴리스 빌드에는 감시
  스레드 자체가 존재하지 않는다. (d) `scripts/docs-gate.mjs` 는 마커 규약 위반·드리프트를
  fail-closed 로 모아 보고하고, ko 미러 완전성도 게이트가 강제한다.
- **근거 코드**: `packages/types/src/frame-engine-contract.ts:61-163`
  (`validateFrameEngineOptions` — mismatch/unenforceable),
  `packages/types/src/frame-engine-options.ts:64` (`contractVerification` 정책 노브),
  `packages/cli/src/dev.ts` `runConfigDev`
  (parity 게이트 fail-closed 발행), Android 게이트:
  `examples/react-native-calculator/modules/rustra-jsi/android/src/main/java/dev/rustra/bridge/RustraBridgeModule.kt:35`
  (iOS 는 `RUSTRA_HOT_CORE_DIR` env 게이트와 대칭), `scripts/docs-gate.mjs`.
- **위반 시 동작**: 게이트는 통과 대신 실패를 낸다 — 엔진 생성 거부, reload 미방출,
  CI exit 1. "검증 스킵 후 진행"은 호출자가 `contractVerification` 정책으로 명시적으로
  선택한 경우에만 존재한다 — 조용히 일어나는 스킵은 없다.
- **검증 위치**: `packages/types/src/index.test.ts` (mismatch/unenforceable 경로),
  `packages/cli/src/dev-parity-wiring.test.ts`, `scripts/docs-gate.test.ts`.

## 이 문서가 바뀌면

이 계약의 어떤 항목(S1–S7 포함 총괄 불변식)이라도 의미가 바뀌면 — 강화, 약화, 해석 변경
모두 — **새 ADR 을 `docs/adr/` 에 작성해야 한다** (형식은 `docs/adr/README.md` 참조).
코드가 이 문서와 갈라지면 버그다: 문서를 현실에 맞추는 커밋이라도 계약 변경이면 ADR 로
기록한다. 근거 코드 경로의 **줄 번호 이동**(같은 계약, 다른 줄)은 ADR 없이 갱신할 수 있다.
