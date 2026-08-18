# Follow-up 3: invokeTypedAsync id 노출 + invokeBatch 항목별 취소

날짜: 2026-08-18 · 상위: docs/plans/2026-08-18-production-hardening-design.md 완료 노트 후속 (3)

## 개요

production hardening T1의 취소 인프라(Rust 레지스트리 + FFI 심볼 + dispatch 체크포인트 + JS AbortSignal)는 완비됐지만 두 갭이 남았다: (1) RN JSI `invokeTypedAsync` 가 invocation id 를 노출하지 않아 typed 경로 취소가 얕은 취소로만 동작한다, (2) `invokeBatch` 가 항목별 `options` 를 받지 않아 배치 취소가 `Promise.all` 폴백의 얕은 취소로조차 자동으로 얻어지지 않는다. 이 plan은 **id 노출로 typed 경로 취소 전파의 전제를 만들고, invokeBatch 폴백 경로에 항목별 옵션을 실어 보낸다**. C++ 구현이 없는 신규 표면이므로 Rust 예제 심볼 + C++ JSI 구현 + JS 어댑터까지 포함한다.

## 현재 상태 분석

### 주요 발견사항

- **JS 인터페이스만 존재, 구현 없음**: `packages/react-native/src/index.ts:149-157` — `RustraJSIAsyncNative.invokeTypedAsync?(name, args, onSuccess, onError): void`. 반환 `void` — invocation id 없음. C++ JSI(`RustraJSIBridge.cpp`)에는 `invokeTyped`(:343-401)/`invokeTypedBatch`(:403-471)만 있고 **`invokeTypedAsync` 는 미구현**. 현재는 JS 선언 + RN 네이티브 미제공 상태로, `createAsyncEngine` 은 실 기기에서 폴백(동기 fast 엔진)으로 돈다.
- **Rust 프레임워크 FFI는 준비 완료**: `crates/rustra/src/ffi.rs:533-561` `rustra_ffi_invoke_async(payload, len, user_data, on_complete, invocation_id: *mut u64)` — id 발급 + 취소 체크포인트 포함. `rustra_ffi_invoke_cancel`(:622-625), `rustra_ffi_cancellation_status`(:635-642). **단 이 심볼은 JSON/postcard envelope 와이어다** — C++ typed 경로의 rkyv V2 와이어(cmd_id+postcard)와 불일치(아래 접근 방식 참조).
- **제한의 근거 주석**: `packages/react-native/src/index.ts:241-246` — "invokeTypedAsync C++ 시그니처가 invocation id 를 노출하지 않아 취소를 전파할 핸들이 없다. 전파하려면 네이티브가 rustra_ffi_invoke_async(invocation_id out-param) + rustra_ffi_invoke_cancel 을 JSI 로 노출해야 한다."
- **id 노출 패턴 선례**: JS `invokeAsync` 가 이미 이 형태다 — `packages/types/src/index.ts:350` `invokeAsync?(payload, onDone): number`. C++ JSI HostFunction 은 동기 Value 반환, 비동기 결과는 콜백 — id 를 동기 반환값으로 노출하는 것이 확립된 패턴.
- **C++ typed 경로의 호출 심볼**: `invokeTyped`/`invokeTypedBatch` 는 `rustra_calculator_invoke_rkyv_v2`(calculator 소유 심볼)를 직접 호출한다. 제너릭 `rustra_ffi_invoke_async` 를 쓰지 않는다. typed 인코딩은 C++ generated codecs(`rustra-generated-codecs.hpp`)에서 수행.
- **invokeBatch 폴백 누락**: `packages/types/src/index.ts:33` `BatchEntry = { command, args }` — options 필드 없음. 폴백 경로(:809) `this.invoke(e.command, e.args)` — 3번째 인자(options) 미전달. TODO(T1) 주석(:245-247)이 명시적.
- **typed batch 단일 횡단은 동기 루프**: C++ `invokeTypedBatch` 는 각 항목마다 `rustra_calculator_invoke_rkyv_v2` 를 동기 호출(:436) — 레지스트리 등록 자체가 없고, 첫 에러에서 throw(fail-fast, :446-457). 취소 불가. 배치 관련 Rust FFI 심볼은 없다(배치는 C++/JS 레이어 루프).
- **추가 발견 (버그)**: C++ `invokeTyped`/`invokeTypedBatch` 가 `rustra_calculator_invoke_rkyv_v2` 의 반환 버퍼를 `rustra_ffi_free` 로 해제한다 — calculator 심볼은 FFI_MAGIC 헤더 없는 `Box<[u8]>` 을 반환하는 반면 `rustra_ffi_free` 는 magic 검사 후 `header_ptr = ptr - 8` 로 역산해 Box 를 재구성한다 (ffi.rs:690-725). **짝이 안 맞는 free — release 빌드에서 잘못된 레이아웃의 Box 해제 = 정의되지 않은 동작/크래시 위험.** debug 빌드에서는 free_guard 가 NotLive 로 분류해 abort 시킨다. 이 plan에서 함께 수정한다.

### 트레이드오프 (설계 노트)

- **전파는 JS 코덱 경로만** 원칙(T1 설계)은 유지한다 — 이 plan은 "typed 경로 전파의 **전제**(id 노출)"를 완성하는 것이고, 실제 typed 전파 활성화(전파 조건에 typed 경로 포함)는 별도 결정으로 남긴다. 이유: 3-tier × 취소 매트릭스 폭발 방지.
- **`invokeTypedBatch` 단일 횡단의 취소는 지원하지 않는다**: C++ 동기 루프라 항목별 취소 지점이 없다. async 배치 재설계는 범위 확장이므로 유예 — 대신 **폴백 경로의 항목별 취소**를 완성한다. signal 있는 항목이 하나라도 섞이면 전체가 Promise.all 폴백으로 라우팅되고 각 항목은 기존 invoke 3-tier 취소 정책(전파/얕은)을 따른다.
- **와이어 불일치 해법 선택**: C++ typed async 에 (옵션 1) JSON envelope 로 `rustra_ffi_invoke_json_async` 재사용 — 취소는 되지만 typed postcard fast path 포기, (옵션 2) 소비 크레이트(calculator)에 rkyv V2 와이어 + 취소 레지스트리 연동 심볼 추가. **옵션 2 채택** — typed fast path 유지가 이 브릿지의 존재 이유. `rustra::cancel` 모듈이 이미 `pub` 라(register/cancel/complete/status 전부 공개) 소비 크레이트가 체크포인트를 직접 구성할 수 있다.
- **C++ 신규 표면은 예제 계층**: `invokeTypedAsync` 구현은 `examples/react-native-calculator/modules/rustra-jsi`(참조 구현)에 추가한다. 프레임워크 크레이트(rustra)는 이미 취소 인프라를 공개 API 로 제공 — Rust 프레임워크 변경은 불필요하다.

## 목표 상태

1. **JS 인터페이스**: `RustraJSIAsyncNative.invokeTypedAsync` 반환형 `void` → `number | void` (invocation id). `invokeCancel?(id): boolean` 추가. 구형 네이티브(void 반환)와의 하위 호환은 JS 측 `typeof id === 'number'` 가드로 처리.
2. **Rust 예제 심볼**: calculator 크레이트에 `rustra_calculator_invoke_rkyv_v2_async` — id 발급 + cancel 체크포인트 + rkyv V2 dispatch + `encode_rkyv_v2_error` 에러 프레임.
3. **C++ JSI 참조 구현**: `invokeTypedAsync(name, args, onSuccess, onError) → number` — encode_by_name → async 심볼 → id 동기 반환, 결과는 CallInvoker 로 JS 스레드 마샬링. `invokeCancel(id)` 은 `rustra_ffi_invoke_cancel` 그대로 JSI 노출.
4. **RN JS 어댑터**: `createAsyncEngine` 이 signal 있는 경로에서 네이티브가 `invokeCancel` 을 노출하면 id 기반 전파형 취소, 아니면 기존 얕은 취소 유지.
5. **invokeBatch 항목별 취소 (폴백 경로)**: `BatchEntry` 에 `options?: InvokeOptions` 추가 + 폴백 `this.invoke(e.command, e.args, e.options)` 전달. 단일 횡단 조건에 "signal 없는 항목만" 추가 — 이 경로는 취소 불가임을 JSDoc 명시.
6. **C++ free 짝 버그 수정**: `invokeTyped`/`invokeTypedBatch` 의 해제를 `rustra_ffi_free` → `rustra_calculator_free_buffer` 로 교체.

## 범위 제한 (하지 않을 것)

- **typed batch 단일 횡단의 취소**: C++ 동기 루프 재설계는 하지 않는다. signal 있는 항목 포함 시 전체 Promise.all 폴백으로 충분하다(항목별 invoke 가 각자 취소 정책 적용).
- **tier 3 동적 경로의 전파 활성화**: T1 원칙 유지 (JS 코덱 tier2 만 전파).
- **`rustra_ffi_invoke_async` 바이트 경로의 JSI 직접 노출**: typed 경로와 중복 — 하지 않는다.
- **Lynx 측 async 엔진**: Lynx 는 `createRkyvV2Engine` 위임이라 네이티브가 `invokeAsync` 를 노출하면 자동 승격 — 별도 작업 없음 (runner 템플릿의 별도 과제).
- **`cancellation_status` 의 JS 노출**: 핸들러 내부 폴링용 공개 API 는 이미 FFI 로 존재, JS 노출은 요청된 적 없음 — 유예.
- **JS `invoke` 전파 조건의 typed 경로 확장**(types:744 의 `!onTypedPath` 완화): 별도 결정 사항 — 이 plan은 네이티브 표면(id/cancel)과 어댑터 준비만 완성.

## 구현 접근 방식

3 Phase: (A) Rust 예제 심볼 + C++ JSI 표면 + free 짝 수정, (B) RN JS 어댑터, (C) invokeBatch 항목별 옵션. (B)와 (C)는 독립적이나 (B)가 (A)의 시그니처에 의존하므로 순차 진행이 자연스럽다.

## Phase 1: C++ async 심볼 + JSI 표면 (Rust 예제 크레이트 + C++ JSI)

### 개요

calculator 크레이트에 rkyv V2 async 심볼 추가, C++ JSI에 `invokeTypedAsync`/`invokeCancel` HostFunction 추가, free 짝 버그 수정.

### 필요한 변경사항:

#### 1. `examples/calculator/src/lib.rs` — async 심볼

**변경사항**: `rustra_calculator_invoke_rkyv_v2`(lib.rs:1097-1117) 옆에 async 변형 추가. `rustra::ffi` 의 `run_worker` 는 private 이므로 동일 계약의 미니 러너를 소비 크레이트에 둔다:

```rust
/// rkyv V2 비동기 진입점 — `rustra_ffi_invoke_async` 와 동일한 계약
/// (invocation_id 발급, 워커 스레드 dispatch, cancel 체크포인트,
/// complete 후 on_complete)을 rkyv V2 와이어로 제공한다.
pub type RustraCalculatorAsyncCallback =
    unsafe extern "C" fn(user_data: *mut std::ffi::c_void, resp: *mut u8, resp_len: usize);

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_rkyv_v2_async(
    payload: *const u8,
    payload_len: usize,
    user_data: *mut std::ffi::c_void,
    on_complete: Option<RustraCalculatorAsyncCallback>,
    invocation_id: *mut u64,
) {
    let id = rustra::cancel::register_invocation();
    if !invocation_id.is_null() {
        unsafe { *invocation_id = id };
    }
    let bytes = if payload.is_null() || payload_len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len).to_vec() }
    };
    std::thread::spawn(move || {
        // cancel 체크포인트 — Cancelled 면 핸들러를 시작하지 않는다.
        let resp = if rustra::cancel::status(id) == rustra::cancel::Status::Cancelled {
            rustra::encode_rkyv_v2_error(&RustraError::cancelled(
                "invocation cancelled before dispatch",
            ))
        } else {
            match rustra::ffi::get_package()
                .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))
                .and_then(|pkg| pkg.invoke_rkyv_v2(&bytes))
            {
                Ok(bytes) => bytes,
                Err(error) => rustra::encode_rkyv_v2_error(&error),
            }
        };
        rustra::cancel::complete_invocation(id);
        if let Some(cb) = on_complete {
            let mut out_len = 0;
            let ptr = alloc_response(resp, &mut out_len);
            unsafe { cb(user_data, ptr, out_len) };
        }
    });
}
```

- `alloc_response` 는 calculator 의 기존 private 헬퍼(lib.rs:721) 재사용 — 응답 버퍼는 `rustra_calculator_free_buffer` 계약으로 해제된다(호스트 콜백 내). `on_complete` 가 None 인 경우에도 버퍼를 만들지 않도록 분기(누수 방지 — 위 코드는 Some 분기에서만 alloc).
- `pkg.invoke_rkyv_v2` 를 호출하므로 **Follow-up 1의 크기 게이트를 자동 상속**한다 — 머지 순서와 무관하게 양쪽이 모두 머지되면 게이트가 적용된다.
- `rustra::cancel` 이 `pub mod` 인 것을 확인했다(lib.rs:114 `pub mod cancel;`) — 소비 크레이트 경로 그대로 사용 가능.

#### 2. `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.hpp` — extern 선언

**변경사항**: 기존 extern "C" 블록에 추가:

```cpp
uint64_t 루스트라… // (실제 구현 — 아래는 의도만)
void rustra_calculator_invoke_rkyv_v2_async(
  const uint8_t* payload, size_t payload_len, void* user_data,
  void (*on_complete)(void*, uint8_t*, size_t), uint64_t* invocation_id);
bool rustra_ffi_invoke_cancel(uint64_t invocation_id);
```

(구현 시 정확한 C 타입으로 — Rust `RustraCalculatorAsyncCallback` 과 ABI 일치: `unsafe extern "C" fn(*mut c_void, *mut u8, usize)`.)

#### 3. `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp` — HostFunction 3종

**변경사항**:

1. **free 짝 수정 (기존 버그)**: `invokeTyped`(:371-397)와 `invokeTypedBatch`(:442-465) 내 모든 `rustra_ffi_free(resp, out_len)` → `rustra_calculator_free_buffer(resp, out_len)`. calculator 심볼은 magic 헤더 없는 Box 라 `rustra_ffi_free` 의 ptr-8 역산이 잘못된 레이아웃을 재구성한다.
2. **`invokeTypedAsync` HostFunction** 추가 — 시그니처 `(name, args, onSuccess, onError) → number(id)`:
   - encode_by_name 으로 postcard 요청 생성(기존 invokeTyped 와 동일).
   - 콜백 컨텍스트 구조체(name, onSuccess/onError JS 함수 캡처, CallInvoker)를 heap 에 두고 `user_data` 로 전달 — on_complete C 콜백에서 CallInvoker::invokeAsync 로 JS 스레드에 마샬링(EventDispatcher 패턴 재사용). CallInvoker 없는 호스트는 onError 즉시 호출 후 정리(또는 큐잉 폴링 — 최소 구현은 CallInvoker 필수로 하고 미제공 시 에러 반환을 JSDoc 명시).
   - on_complete 내 응답 분기: `resp[0] == 1` → `decode_by_name` → onSuccess(result). `resp[0] == 0` → 에러 와이어 `[err_len u16 @8][postcard{code,message} @10]` 를 디코딩해 `"code: message"` 문자열로 onError(RustraError Display 형태 — JS `parseRustraErrorString` 이 코드 복원). 기존 invokeTyped 의 에러 분기는 평문 errLen 만 읽으므로, postcard 디코딩을 위해 generated codecs 의 postcard reader(rc::Reader)로 code/message 두 문자열을 읽는다.
   - 콜백 실행 후 컨텍스트 해제(정확히 1회).
   - 반환: `Value(static_cast<double>(id))`.
3. **`invokeCancel` HostFunction** 추가 — `(id) → boolean`, `rustra_ffi_invoke_cancel(id)` 전달.

#### 4. C++ shim 테스트

**파일**: `examples/react-native-calculator/modules/rustra-jsi/ios/test-rustra-codec.cpp` (또는 `test-jsi-shim.hpp` 기반 신설 케이스)
**변경사항**: `run-cpp-codec-tests.sh` 실행 목록에 포함:

- invokeTypedAsync 성공 라운드트립(id number 반환 + onSuccess 결과)
- pre-cancel: id 발급 → cancel → on_complete 가 cancelled 에러 프레임으로 도착 → onError("cancelled: …")
- free 짝: invokeTyped/invokeTypedBatch 반복 호출이 크래시 없이 동작(ASan 빌드면 더 확실 — 스크립트 여부는 구현 시 확인)

### 성공 기준 (Phase 1):

#### 자동 검증:

- [ ] `cargo fmt --all -- --check` + `cargo clippy -p rustra-calculator-example --all-targets -- -D warnings` 통과
- [ ] `cargo test -p rustra-calculator-example` green — async 심볼 통합 테스트: id 발급(non-null out-param), pre-cancel 시 `cancelled` 코드 에러 프레임, 정상 라운드트립, 완료 후 레지스트리 정리(status Unknown)
- [ ] C++ shim 테스트(`bash examples/react-native-calculator/modules/rustra-jsi/ios/run-cpp-codec-tests.sh`) green — 위 3 케이스
- [ ] `cargo test --workspace` 전체 green (프레임워크 무변경이므로 회귀만)

#### 수동 검증:

- [ ] u64 id → JS number 변환이 안전한지 확인 (id 카운터가 2^53 미만 — 실용적 보증, 코드 주석 문서화)
- [ ] iOS 시뮬레이터 빌드 1회(선택 — shim 테스트가 논리를 커버)

## Phase 2: RN JS 어댑터 — id 노출 + 전파형 취소

### 개요

JS 인터페이스 시그니처 변경(void → number | void) + `createAsyncEngine` 전파 분기 + `invokeBatch` 항목별 옵션.

### 필요한 변경사항:

#### 1. `packages/react-native/src/index.ts` — 인터페이스 + 어댑터

**변경사항**:

1. `RustraJSIAsyncNative`(149-157) 확장:

```ts
export type RustraJSIAsyncNative = RustraJSINative & {
  /**
   * 성공/에러 후 JS 콜백 큐에서 호출될 콜백 등록형 비동기 호출.
   * 반환값: invocation id (취소 핸들). 구형 네이티브가 undefined 를
   * 반환하면 얕은 취소로 폴백한다.
   */
  invokeTypedAsync?(
    name: string,
    args: unknown,
    onSuccess: (result: unknown) => void,
    onError: (message: string) => void,
  ): number | void;
  /** 진행 중 async 호출 취소 — invokeTypedAsync 가 반환한 id. */
  invokeCancel?(invocationId: number): boolean;
};
```

2. `createAsyncEngine`(208-261) — signal 경로에 전파 분기 추가(기존 얕은 취소 주석 :241-246 교체):

```ts
// 전파 가능: 네이티브가 invokeCancel 을 노출하면 invokeTypedAsync 의
// id 로 Rust 취소 체크포인트까지 전파된다. 구형 네이티브(void 반환
// 또는 invokeCancel 미노출)는 얕은 취소로 폴백한다.
if (typeof native.invokeCancel === 'function') {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let invocationId = -1;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (invocationId >= 0) native.invokeCancel!(invocationId);
      reject(new RustraCommandError('cancelled', `invoke("${command}") aborted`, true));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      const id = invokeTypedAsync(
        command,
        args,
        (result) => {
          if (settled) return; // 늦은 콜백 무시
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(result as T);
        },
        (message) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(parseRustraErrorString(message));
        },
      );
      if (typeof id === 'number') invocationId = id;
    } catch (err) {
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(err instanceof Error ? err : new RustraCommandError('invoke.failed', String(err)));
    }
  });
}
return raceAbortShallow(/* 기존 경로 유지 */);
```

(types:745-790 전파 경로와 동일한 settled/리스너 정리 패턴 — 네이티브 콜백이 동기로 올 수 있는 경우의 가드 포함.)

#### 2. `packages/types/src/index.ts` — invokeBatch 항목별 옵션

**변경사항**:

1. `BatchEntry`(:33) 확장:

```ts
/** invokeBatch 의 입력 항목. `options.signal` 은 항목 단위 취소로 전달된다. */
export type BatchEntry = { command: string; args?: unknown; options?: InvokeOptions };
```

2. 단일 횡단 조건(:798-801)에 signal 검사 추가:

```ts
if (
  hasBatchPath &&
  entries.length > 0 &&
  entries.every((e) => native.hasStaticCodec!(e.command)) &&
  entries.every((e) => !e.options?.signal) // signal 항목은 취소 가능한 폴백으로
) {
```

3. 폴백(:809)에 options 전달:

```ts
return Promise.all(entries.map((e) => this.invoke<T>(e.command, e.args, e.options)));
```

4. `invokeBatch` JSDoc(:239-256)의 TODO(T1) 제거 후 새 계약 문서화: 항목별 signal 은 각 항목의 invoke 취소 정책(전파/얕은)을 따른다. 단일 횡단 경로는 취소 미지원 — signal 없는 정적 항목 전부일 때만 탄다.

#### 3. 테스트

**파일**: `packages/react-native/src/index.test.ts`, `packages/types/src/index.test.ts`
**변경사항**:

- RN: (a) id 반환 + invokeCancel mock → abort 시 `invokeCancel(id)` 호출 + cancelled reject + 늦은 onSuccess 무시, (b) void 반환(구형) → abort 시 invokeCancel 미호출 + cancelled reject(얕은 유지), (c) invokeCancel 미노출 → 얕은 폴백.
- types: (a) signal 항목 1개 포함 배치 → 단일 횡단 안 탐(invokeTypedBatch 미호출) + Promise.all 로 항목별 취소, (b) signal 없는 정적 전부 → 단일 횡단 유지(기존 테스트 회귀), (c) 옵션 없는 기존 형태 BatchEntry 동작 불변.

### 성공 기준 (Phase 2):

#### 자동 검증:

- [ ] `npm run build` + `npm run test:packages` green — 위 신규 테스트 포함
- [ ] `npm run test:types` green — 기존 배치 테스트 5종(index.test.ts:337,367,391,485,500) 회귀 포함
- [ ] `npm run test:ts:node` / `npm run test -w @rustra/cli` green (전체 게이트)
- [ ] `npm run lint` 0 warn
- [ ] `npm run test:app:react-native` (예제 앱 타입체크) 통과

#### 수동 검증:

- [ ] iOS 시뮬레이터에서 AbortController 로 heavy invoke 중단 → Rust 핸들러 미시작(로그) + cancelled 에러 수신 (선택 — shim/유닛 테스트가 논리 커버)

## 테스트 전략

### 단위 테스트 (JS)

- RN 전파형/얕은 폴백/구형 void 반환 3분기 (위 Phase 2 항목)
- types 배치 라우팅/항목별 취소/회귀 (위 항목)

### C++ shim 테스트

- invokeTypedAsync 성공/cancel/free 짝 (Phase 1)

### 수동 테스트 단계

1. iOS 시뮬레이터 E2E 취소 (선택)
2. `npm run test:app:react-native` 타입체크

## 성능 고려사항

- `invokeTypedAsync` 는 per-call 스레드 스판 — 동기 `invokeTyped` 대비 오버헤드. 무거운 연산 오프로드가 목적이므로 수용. 문서화: 대량 얕은 호출엔 동기 fast path 권장.
- JS 전파 분기는 signal 있는 경우에만 추가 — signal 없는 경로 불변.
- invokeBatch 폴백 조건에 `!e.options?.signal` 검사 1회 — 무시 가능.

## 마이그레이션 참고사항

- `invokeTypedAsync` 반환형 `void → number | void` — 구형 네이티브는 JS 가 typeof 가드로 얕은 취소 폴백하므로 **하위 호환**.
- `BatchEntry` optional 필드 추가 — 기존 `{command, args}` 그대로 유효, 와이어 변경 없음(JS 내부 타입).
- **C++ free 짝 수정은 release 빌드 안정성 픽스** — 기존 release 빌드에서 `invokeTyped`/`invokeTypedBatch` 사용자는 재빌드 권장 (debug 빌드는 free_guard 가 이미 abort 로 노출 중이었음).
- dist 커밋 규약: `npm run build` 후 포함 (pre-commit prettier — amend 필요, 메모리 참조).

## 참고 자료

- 상위 설계: `docs/plans/2026-08-18-production-hardening-design.md` (트랙 1 완료 노트)
- Rust 취소 인프라: `crates/rustra/src/cancel.rs`, `crates/rustra/src/ffi.rs:533-642`
- JS 얕은 취소 제한 주석: `packages/react-native/src/index.ts:241-246`
- invokeBatch TODO: `packages/types/src/index.ts:245-247`
- C++ JSI 참조 구현: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp`
- EventDispatcher (CallInvoker 마샬링 패턴): `RustraJSIBridge.cpp:53-188`
- JS 전파 경로 선례(types invokeAsync): `packages/types/src/index.ts:744-794`
