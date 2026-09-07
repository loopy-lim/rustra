# 역방향 콜백 — 구현 계획 (2026-09-08)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

설계: `2026-09-07-reverse-callbacks-design.md` / 리서치: `docs/research/2026-09-07-reverse-callbacks.md`

**Goal:** 커맨드 실행 중 Rust 가 JS 함수를 호출하는 표면을 착지한다 — `CallbackHandle`(채널 코어 재사용, 수명만 커맨드 스코프) + 코드젱 클라이언트의 함수 인자 설탕(발급→배선→invoke→settle 자동 drop). 경쟁 격차 #4("반환값 있는 JS 함수" — UniFFI callback_interface·Nitro 대응) 해소. **기존 채널 어댑터 API·와이어 프레임(단방향)·호스트 런타임은 무변경.**

**Architecture:** 설계 §A-§G 그대로. 채널 코어(`ChannelHost` 단일 테이블·핸들 공간·전달 계약)를 공유하는 `CallbackHandle` newtype이 중심이다. 구분 정보(채널 vs 콜백)는 JS 래퍼와 코드젱이 소유하고 코어는 "u32 → sender"만 안다. 선언은 커맨드 입력 스키마 안에 산다(독립 섹션 아님 — 계약 해시·드리프트 게이트 자동 커버). request/response는 capability 호스트(Tauri/RN-async)만, 타임아웃 필수.

**Tech Stack:** Rust (crates/rustra), TypeScript (packages/types, packages/cli, 4호스트 어댑터), C++ (packages/react-native/native/cpp), 예제 (examples/calculator).

**선행 착지(이 계획 밖에서 완료됨):** 설계 §G 슬라이스 2 — RN CallInvoker-less 호스트의 채널 프레임 영구 미소비 공백(리서치 §3.5)은 `drainEvents`가 ChannelDispatcher 도 drain + 채널 `pollMs` 폴백으로 별도 커밋됐다. 본 트랙의 콜백은 이 폴백을 상속받는다.

---

### Task 1: `CallbackHandle` + `CallbackHandleOf<P>` — Rust 코어 타입과 스키마 인코딩

**Files:**

- Modify: `crates/rustra/src/channels_handles.rs` (`CallbackHandle` newtype + `call`)
- Create: `crates/rustra/src/channels_callbacks.rs` (`CallbackHandleOf<P>` 제네릭 마커 + schemars 인코딩) — 400줄 상한 준수 분리
- Modify: `crates/rustra/src/lib.rs` (모듈 등록 + 필요시 prelude 재수출)
- Test: `crates/rustra/src/channels_callbacks_tests.rs` + `lib.rs` 등록

**Step 1: 실패 테스트 작성** — 채널 핸들 테이블에 발급된 핸들로 `CallbackHandle::call` 이 JSON 페이로드를 JS 싱크에 전달하는 단언(기존 channels 테스트의 싱크 목 패턴 준용), `CallbackHandleOf<ProgressPayload>` 의 serde 직렬화가 plain u32 와 동일(단일 allOf newtype), schemars 정의 이름이 렌더러 계약을 만족하는지의 단언.

**Step 2: 실패 확인** — `cargo test -p rustra channels_callbacks` → 컴파일 실패.

**Step 3: 구현**

```rust
/// 커맨드 인자용 콜백 핸들 — wire 는 ChannelHandle 과 동일한 plain u32.
/// 차이는 수명(커맨드 스코프 자동 해제 — JS 래퍼 소관)과 TS 표면(함수 타입).
pub struct CallbackHandle(pub u32);

impl CallbackHandle {
    /// 단방향 호출 — 페이로드 JSON을 JS 콜백에 전달. 만료 핸들은 false(무시).
    pub fn call(&self, payload: &str) -> bool { host().send(self.0, payload) }
}
```

- `CallbackHandleOf<P>`: serde/schemars 표면은 `ChannelHandle` 과 동일하게 u32 newtype 에 정의 이름이 페이로드 타입을 함의하도록 구성. **오픈 질문 7 해소가 이 태스크의 핵심 산출물** — schemars 가 제네릭 마커에 부여하는 실제 정의 이름(예: `CallbackHandleOf_ProgressPayload`)을 실측하고, "정의 이름 → TS 함수 타입" 렌더링 계약(Task 3)이 기계적으로 파싱 가능한 형태로 확정한다. 페이로드 타입의 정의는 참조로 함께 발행되야 한다(단순 마커로는 payload 스키마가 안 나오므로, `schemars::gen` 커스터마이징 또한 수단 후보 — 실측 후 계약 문서로 남긴다).
- `call_wait` 은 Task 6 에서 추가(이 태스크에 없음).

**Step 4: PASS 확인** — `cargo test -p rustra channels_callbacks && cargo test -p rustra`

**Step 5: 커밋** — `feat(core): CallbackHandle + CallbackHandleOf<P> — 채널 코어 재사용 콜백 핸들 (단방향 call)`

---

### Task 2: `EngineSupports.callbacks` + 4어댑터 정적 값 + `callback.unavailable`

**Files:**

- Modify: `packages/types/src/public.ts` (`EngineSupports`에 `callbacks: 'none' | 'one-way' | 'request-response'` — additive 필드, 기존 `channels: boolean` 유지)
- Modify: `packages/types/src/errors.ts` (`RustraErrorCode`에 `CallbackUnavailable: 'callback.unavailable'` — 이 태스크에서 쓰는 1종만. 나머지 3종은 Task 6)
- Modify: 4엔진 supports 초기화 지점 — `packages/tauri/src/index.ts`, `packages/node/src/node-core.ts`, `packages/bun/src/bun-ffi.ts`, `packages/react-native/src/react-native-core.ts` (research §3.6 이 실측한 supports 채움 지점). 값은 정적 상수: Tauri `'request-response'`, Node `'one-way'`, Bun `'one-way'`, RN `'request-response'` (design §D.2 — 런타임 감지 분기 없음)
- Test: 각 패키지 기존 supports 테스트 옆에 callbacks 값 단언

**Step 1: 실패 테스트** — 4어댑터 엔진의 `engine.supports?.callbacks` 값 단언. **Step 2: 실패 확인** — `bun run --cwd packages/react-native test` 등. **Step 3: 구현.** **Step 4: PASS — `bun run test:packages` 는 Task 5 이후 전체로 돌리고, 여기선 4패키지 개별 테스트.**

**Step 5: 커밋** — `feat(types): EngineSupports.callbacks 3단계 — 4어댑터 정적 값 + callback.unavailable`

---

### Task 3: CLI 렌더링 — `CallbackHandleOf` 정의 → TS 함수 타입

**Files:**

- Modify: `packages/cli/src/codegen.ts` (`tsTypeFromSchema` 계층 — `CallbackHandleOf_*` 정의 이름 인식)
- Modify: `packages/cli/src/generate-surface.ts` (`generateTypesTs` — 해당 정의를 `(payload: P) => void` 함수 타입으로 발행, 채널 원본 u32 newtype 정의는 발행하지 않음)
- Test: `packages/cli/src/generate.test.ts` (또는 신설 `generate-callbacks.test.ts`) — Task 1 에서 확정한 인코딩 fixture 사용

**계약:**

- 입력의 해당 필드는 `(payload: P) => void` 로 발행된다(단방향). request/response 반환 타입 `R` 은 Task 6 이후 스키마 확장이 있을 때만 `(payload: P) => R | Promise<R>` 로 확장 — 이 태스크는 단방향만.
- 함수 타입으로 바뀐 필드는 postcard 라우팅(`bufferCommandField`/`generatedFieldRoute`)에서 **일반 필드로 취급되지 않도록** 제외한다(값은 런타임에 핸들 숫자로 치환되어 인코딩된다 — Task 4 의 몫이지만 타입 렌더링과 라우팅의 정합이 이 태스크에서 깨지지 않는지 확인).
- 콜백 필드가 하나라도 있는 커맨드의 `commands.ts` 헬퍼는 Task 4 의 새 런타임 헬퍼를 쓰도록 바뀐다(이 태스크에서 렌더러만, 배선은 Task 4).

**Step 1: 실패 테스트** — 함수 타입 필드 렌더링 단언 + 콜백 없는 스키마 출력 바이트 불변 단언. **Step 2~4: 동일 패턴, `bun run --cwd packages/cli test`.**

**Step 5: 커밋** — `feat(cli): CallbackHandleOf 렌더링 — 커맨드 입력의 콜백 필드를 함수 타입으로 발행`

---

### Task 4: JS 런타임 설탕 — `createCallback` 4호스트 + `invokeGeneratedCallbacks`

**Files:**

- Create: `packages/types/src/global-callbacks.ts` — 콜백 어댑터 전역(`setCallbackAdapter` / 내부 해석, `configure()` 관례 준용). 미설정 상태에서 콜백 인자 호출 시 `callback.unavailable` loud-fail
- Modify: `packages/types/src/global-fields.ts` 또는 신설 — `invokeGeneratedCallbacks<TInput, TOutput>(commandId, name, input, callbackFields: readonly string[], options)`: (1) 각 콜백 필드값(함수)을 어댑터 `createCallback(fn)` 으로 발급, (2) 핸들 숫자로 치환된 와이어 입력 구성, (3) invoke, (4) **settle(성공/거부/pre-abort) 후 발급 핸들 전부 drop(finally)**, (5) 발급/배선 실패 시 즉시 drop 후 throw (tauri-channels.ts:131-162 정리 패턴)
- Modify: 4호스트 채널 어댑터 파일(`packages/tauri/src/tauri-channels.ts`, `packages/node/src/node-channels.ts`, `packages/bun/src/bun-channels.ts`, `packages/react-native/src/react-native-events.ts`) — 각각 `createCallback(fn)` export: 기존 `createChannel` 발급/수신 계약 그대로 + 어댑터 초기화 시점에 `setCallbackAdapter` 자동 바인딩. **단방향 예외 정책 통일**: 사용자 함수가 던지면 격리 + debug 싱크 관측(`observeBytesPayloadError` 패턴, tauri-channels.ts:203-213 — Node/Bun 의 console.error 관행을 이 경로로 수렴)
- Modify: `packages/cli/src/generate-commands.ts` — 콜백 필드가 있는 커맨드는 `invokeGeneratedCallbacks` 배선(콜백 필드 키 목록 전달)
- Test: `packages/types/src/index.test.ts`(헬퍼 수명 계약 — settle 후 drop, 발급 실패 정리, pre-abort 정리), 각 어댑터 패키지 테스트

**Step 1: 실패 테스트 우선 — 특히 수명 계약 3종(settle-drop/발급실패-drop/pre-abort-drop)은 이 트랙의 안전성 본체다.**

**Step 2~4: 동일 패턴.** 검증: `bun run --cwd packages/types test` + 4패키지 개별 테스트 + `bun run --cwd packages/cli test`.

**Step 5: 커밋** — `feat(ts): 콜백 함수 인자 설탕 — createCallback 4호스트 + invokeGeneratedCallbacks 자동 수명`

---

### Task 5: 예제 `long_task_demo` — 슬라이스 1 e2e 패리티

**Files:**

- Modify: `examples/calculator/src/lib.rs` — `long_task_demo` 커맨드(커맨드 인자 콜백 2개: `on_progress`(JSON 진행률) + `on_chunk`(바이트 경로 취약점 검증용은 아니고 JSON 청크) — `channel_demo` 관례 준용 lib.rs:957-1027)
- Regenerate: `examples/calculator/generated/` — schema.json·types.ts(함수 타입 필드)·commands.ts(새 헬퍼 배선)·contract.ts·`.rustra-generated.json`
- Test: `examples/calculator/ts/` 신설 `callbacks.test.ts` — 4호스트 앱 경로 중 노드/번 어댑터로 e2e(실제 싱크 목 + 드레인), 진행률 콜백 순서(FIFO) 단언, 콜백 예외가 커맨드를 죽이지 않는 단언, settle 후 stale send 무시 단언
- Modify: `api-surface/snapshot.json` (Task 1 신규 심볼 — `bun run test:api-surface` 갱신 지시)

**Step 1: 실패 테스트 → Step 3: 구현+재생성(`cargo run -p rustra-calculator-example` 스키마 프로브 → `rustra codegen --config rustra.json`) → Step 4: `bun test examples/calculator/ts/*.test.ts && bun run test:ts:node && bun run test:api-surface`**

**Step 5: 커밋** — `feat(example): long_task_demo — 커맨드 인자 콜백 e2e 패리티 + api-surface 갱신`

---

### Task 6: request/response (Tauri) — `call_wait` + oneshot 레지스트리

**Files:**

- Modify: `crates/rustra/src/channels_callbacks.rs` — `call_wait(&self, payload: &str, timeout: Duration) -> Result<String, CallbackError>` (타임아웃 필수 — 기본값 없음, design §D.3)
- Modify: `crates/rustra/src/channels_host.rs` (또는 신규 `callbacks_registry.rs`) — `(handle, seq) → oneshot` 대기 레지스트리. 완료/drop/타임아웃 시 entry 제거(`complete_invocation` 관행 준용, cancel.rs:69-75). drop_channel 시 해당 핸들 미회신 entry 즉시 실패(`callback.cancelled`)
- Modify: 호출 프레임 확장 — request/response 호출은 기존 JSON 프레임에 `seq`/`expectsReply` 변형을 실는다(단방향 형태와 공존 — design §D.3 프레임 계약)
- Modify: `crates/rustra/src/tauri_support.rs` — 신규 커맨드 `rustra_callback_reply { handle, seq, ok, value }` 를 `rustra_dispatch` 계열 등록 지점(:208-214)에 추가
- Modify: `packages/types/src/errors.ts` — `CallbackTimeout: 'callback.timeout'`, `CallbackError: 'callback.error'`, `CallbackCancelled: 'callback.cancelled'` (additive)
- Modify: `packages/tauri/src/tauri-channels.ts` — request/response 콜백 경로(envelope 인식 + `rustra_callback_reply` 응답). JS 콜백 예외는 **거부 응답**으로 변환(단방향 격리와 대비되는 계약)
- Test: 레지스트리 단위 테스트(타임아웃/응답/드롭 회수 3종) + tauri 어댑터 테스트

**교착 방지 계약 문서화**: `call_wait` 는 Tauri 커맨드 스레드·RN async 워커(ffi_pool 2워커, ffi_pool.rs:13)에서만 호출 가능 — 무한 대기는 풀 고찈이므로 타임아웃 필수.

**Step 5: 커밋** — `feat(core,tauri): 콜백 request/response — call_wait oneshot 레지스트리 + rustra_callback_reply`

---

### Task 7: request/response (RN async) — `callbackReply` HostFunction

**Files:**

- Modify: `packages/react-native/native/cpp/RustraJSIBridge.cpp` — `callbackReply(handle, seq, ok, valueJson)` HostFunction 를 채널 캐시 블록(:870-930)에 추가. async 워커 대기 경로(invokeTypedAsync 선례 :1239-1344 — 컨텍스트 레지스트리 + generation 무효화 + shared_ptr 수명). reload 안전: ChannelDispatcher reset 패턴 준용(:633-646) — entry 회수
- Modify: `packages/react-native/src/react-native-events.ts` — RN 콜백 어댑터의 request/response 경로(폴링 폴백 포함 — CallInvoker-less 호스트는 단방향만, `EngineSupports.callbacks` 문서와 정합)
- Test: RN 패키지 테스트(mock 네이티브) + C++ 자체 검토(컴파일 게이트 없음 — 인접 예외 안전·락 규율 정밀 검토, 실기기는 호스트 검증 체크리스트 항목으로 등록)

**Step 5: 커밋** — `feat(react-native): callbackReply HostFunction — async 경로 request/response + reload 안전`

---

### Task 8: 문서·매트릭스 + 전면 게이트 배터리

**Files (en/ko 쌍 갱신 — `bun run test:docs` 게이트):**

- Modify: `docs/compatibility-matrix.md` + `.ko.md` — 콜백 capability 셀(호스트별 단방향/request-response, CallInvoker-less 폴백)
- Modify: `docs/rust-api-guide.md` + `.ko.md` — `CallbackHandle`/`CallbackHandleOf<P>` 절(채널과의 역할 분담: 커맨드 스코프 = 콜백, 명시 수명 = 채널; `call_wait` 교착 방지 계약·타임아웃 필수)
- Modify: `docs/getting-started.md` + `.ko.md` — 함수 인자 설탕 사용례(생성 클라이언트에서 `(p) => void` 인자 그대로 넘기기)
- Modify: `docs/architecture.md` + `.ko.md` — 채널 코어 재사용 1문단(단일 테이블·핸들 공간, 구분은 JS 래퍼 소유)
- Modify: `docs/verification-checklist.md` — RN 실기기 콜백 스모크 항목 등록(T07 스타일)

**게이트 배터리 (하나라도 깨지면 수정 후 처음부터 재실행):**

```bash
bun run test:packages
cargo test -p rustra -p rustra-macros
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
bun run lint && bun run format:check
bun run test:docs && bun run test:onboarding
bun run test:ts:node && bun run test:adapter:tauri && bun run test:adapter:react-native
bun run test:api-surface
```

**커밋** — `docs: 역방향 콜백 계약 — 매트릭스·가이드·역할 분담 (en/ko)` 후 게이트 정합 커밋.

---

## 명시적 비-목표 (design §H 준수)

- Node loop-stdio request-response(대기 중 교차 읽기 재설계)·Bun threadsafe 재평가 — 별도 트랙.
- 커맨드 밖 수명 콜백·다중 리스너·우선순위 API·백프레셔 튜닝 표면·콜백 바이너리 페이로드·제네레이터 스트리밍 — 전부 YAGNI.
- changeset — 사용자 승인 게이트(생성 금지, 승인 후 별도 커밋).
