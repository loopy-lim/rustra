# 프로덕션 준비성 수정 (Production Readiness Fixes) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 프로덕션 준비성 감사에서 확인된 결함 4건 + 조건부 항목 7건을 수정해 rustra-bridge를 프로덕션 준비 완료 상태로 만든다.

**Architecture:** 수정은 4개 레이어에 걸친다 — (1) RN JSI C++ 브릿지(버퍼 해제 짝·입력 클램프), (2) calculator FFI(panic guard), (3) TS 엔진 레이어(`@rustra/types` timeout·코드젠 살균·버전 주입), (4) 저장소 운영(CI 게이트·메타데이터·브랜치 보호). 각 수정은 기존 테스트 컨벤션(Rust 통합테스트 / `node --test` / CLI 유닛테스트)을 따르는 실패-테스트 우선으로 진행한다.

**Tech Stack:** Rust (edition 2024, catch_unwind/scope guard), C++17 (JSI, iOS/Android 공유), TypeScript ESM (node --test), npm workspaces + changesets, GitHub Actions.

---

## 배경 지식 (zero-context engineer용)

- **저장소 구조**: Rust 워크스페이스(루트 `Cargo.toml`, `crates/rustra` 코어 + `crates/rustra-macros`) + npm 워크스페이스(`packages/*`, @rustra 스코프 9개). 전부 버전 0.2.0 (루트 package.json만 0.1.3, private).
- **와이어 프로토콜**: JS↔Rust 호출은 3계층 — JSON(디버그), postcard V1(범용), rkyv V2(바이너리 fast-path, RN 전용). rkyv V2 요청은 `[cmd_id: u16 LE][본문]`.
- **FFI 버퍼 소유권 규칙 (핵심!)**: 응답 버퍼를 **할당한 쪽의 전용 free 함수**로만 해제해야 한다.
  - `crates/rustra/src/ffi.rs`의 `alloc_response`(ffi.rs:118)는 8바이트 magic 헤더(`"RUST"` + len u32)를 앞에 붙인 `Box<[u8]>`를 반환 → **반드시 `rustra_ffi_free`로 해제** (magic 불일치 시 free 거부 → 누수).
  - `examples/calculator/src/lib.rs`의 `alloc_response`(lib.rs:722)는 magic 헤더 **없는** `Box<[u8]>`를 반환 → **반드시 `rustra_calculator_free_buffer`로 해제**. `rustra_ffi_free`에 넣으면 `ptr-8` OOB 읽기 후 free 거부 → 호출당 누수.
- **RN JSI 브릿지**: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp` 하나를 iOS/Android가 공유 (`android/CMakeLists.txt:22`가 `../ios/` 소스를 컴파일). C++ 테스트는 `run-cpp-codec-tests.sh`(jsi shim 헤더 기반, Xcode 불필요)로 로컬 검증.
- **panic guard 규칙**: Rust panic은 절대 `extern "C"`(nounwind ABI) 경계를 넘으면 안 된다 — 넘으면 프로세스 abort. 코어는 `with_panic_guard`(ffi.rs:282)로 JSON/postcard 경로를 보호하지만 calculator의 rkyv V2 진입점(lib.rs:1099 sync, 1139 async)은 보호 없음.
- **테스트 컨벤션**: Rust 통합테스트는 `crates/rustra/tests/`(파일당 하나의 주제, `cargo test -p rustra --test <name>`), TS는 `node --test`(컴파일 후 `dist/`에서 실행), CLI는 `packages/cli/src/*.test.ts`(tsx 직접 실행). generated/ 디렉터리는 prettier 제외.
- **커밋 컨벤션**: conventional commits (`fix:`, `feat:`, `chore:`, `test:`). pre-commit 훅이 prettier로 포맷하지만 재스테이징 안 하므로 **커밋 후 `git commit --amend --no-edit` 필수** (메모리 lefthook-prettier-amend 참조).
- **빌드 게이트**: `npm run lint:rust`(clippy -D warnings), `npm run fmt:rust:check`, `cargo test`, `npm run test`(전체 TS).

---

### Task 1: RN 브릿지 makeInvoke deleter 테이블 (메모리 누수 + OOB 읽기 수정)

**Files:**
- Modify: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp:282-321`
- Test: `examples/react-native-calculator/modules/rustra-jsi/ios/run-cpp-codec-tests.sh`에 컴파일만 확인(브릿지 전체는 shim 부족 — 컴파일 게이트로 검증)

**Step 1: makeInvoke에 deleter 파라미터 추가**

`RustraJSIBridge.cpp:275`의 `using InvokeFn` 아래에 deleter 타입을 추가하고, `makeInvoke`(282행) 시그니처를 변경한다. 핵심: calculator 심볼(9개)은 `rustra_calculator_free_buffer`, rustra_ffi 심볼(3개)은 `rustra_ffi_free`.

```cpp
using InvokeFn = uint8_t*(*)(const uint8_t*, size_t, size_t*);
using FreeFn = void(*)(uint8_t*, size_t);

// ── free 짝 계약 ──────────────────────────────────────────
// 응답 버퍼는 "할당한 쪽의 전용 free 함수"로만 해제한다.
// - rustra_ffi_* 심볼 → alloc_response(crates/rustra/src/ffi.rs)가 8B magic
//   헤더를 붙임 → rustra_ffi_free (ptr-8 magic 검증 후 해제).
// - rustra_calculator_* 심볼 → alloc_response(examples/calculator/src/lib.rs)
//   가 magic 헤더 없는 Box<[u8]> → rustra_calculator_free_buffer.
//   rustra_ffi_free 는 ptr-8 을 OOB 읽고 magic 불일치로 free 를 거부한다
//   (호출당 누수 + 할당 앞 8바이트 읽기 — 실제 버그였음, 이번에 수정).
struct InvokeEntry {
  InvokeFn fn;
  FreeFn free;
  const char* err;
};

static constexpr InvokeEntry FFI_FREE      = { nullptr, rustra_ffi_free, nullptr }; // fn 은 makeInvoke 인자로 주입
```

`makeInvoke` 람다 본문(286-299행)에서 `rustra_ffi_free(result, out_len);`을 deleter 호출로 교체:

```cpp
  auto makeInvoke = [&](const char* name, InvokeFn fn, FreeFn freeFn, const char* err) {
    auto propNameId = PropNameID::forAscii(rt, name);
    auto hostFn = Function::createFromHostFunction(
      rt, propNameId, 1,
      [fn, freeFn, err](Runtime& rt, const Value&, const Value* args, size_t count) -> Value {
        if (count < 1) {
          throw JSError(rt, std::string("RustraJSI: requires 1 argument — ") + err);
        }
        auto [data, size] = extractBytes(rt, args[0]);
        size_t out_len = 0;
        uint8_t* result = fn(data, size, &out_len);
        if (!result) {
          throw JSError(rt, std::string("RustraJSI: ") + err);
        }
        auto returnValue = createArrayBuffer(rt, result, out_len);
        freeFn(result, out_len);
        return returnValue;
      });
    cache_[name] = std::make_unique<CachedFunction>(
      CachedFunction{std::move(propNameId), std::move(hostFn)});
  };
```

**Step 2: 12개 심볼 등록부를 올바른 deleter로 교체**

305-321행의 등록부를 다음과 같이 바꾼다 (calculator 심볼엔 `rustra_calculator_free_buffer` — hpp:67에 이미 extern 선언됨):

```cpp
  // ── Generic FFI paths (default, json, postcard) — rustra_ffi_free 짝 ──
  makeInvoke("invoke",           rustra_ffi_invoke,              rustra_ffi_free, "Rust returned null");
  makeInvoke("invokeJson",       rustra_ffi_invoke_json,         rustra_ffi_free, "Rust json returned null");
  makeInvoke("invokePostcardFFI", rustra_ffi_invoke_postcard,    rustra_ffi_free, "Rust postcard FFI returned null");

  // ── Per-example benchmark paths (legacy) — rustra_calculator_free_buffer 짝 ──
  // calculator alloc_response 는 magic 헤더 없는 Box<[u8]> (typedInvokeTail
  // 주석 참조) — rustra_ffi_free 로 해제하면 호출당 누수 + 8B 언더리드다.
  makeInvoke("invokeBytes",   rustra_calculator_invoke_bytes,   rustra_calculator_free_buffer, "Rust bytes returned null");
  makeInvoke("invokeMsgpack", rustra_calculator_invoke_msgpack, rustra_calculator_free_buffer, "Rust msgpack returned null");
  makeInvoke("invokeBincode", rustra_calculator_invoke_bincode, rustra_calculator_free_buffer, "Rust bincode returned null");
  makeInvoke("invokePostcard", rustra_calculator_invoke_postcard, rustra_calculator_free_buffer, "Rust postcard returned null");
  makeInvoke("invokeLegacyPostcard", rustra_calculator_invoke_postcard, rustra_calculator_free_buffer, "Rust postcard returned null");
  makeInvoke("invokeRkyv",    rustra_calculator_invoke_rkyv,    rustra_calculator_free_buffer, "Rust rkyv returned null");
  makeInvoke("invokeHybrid",  rustra_calculator_invoke_hybrid,  rustra_calculator_free_buffer, "Rust hybrid returned null");
  makeInvoke("invokeRkyvV2",  rustra_calculator_invoke_rkyv_v2, rustra_calculator_free_buffer, "Rust rkyv v2 returned null");
  makeInvoke("invokeRaw",     rustra_calculator_invoke_raw,     rustra_calculator_free_buffer, "Rust invoke_raw returned null");
```

**Step 3: 컴파일 검증 (C++ 테스트 하네스)**

Run: `cd examples/react-native-calculator/modules/rustra-jsi/ios && clang++ -std=c++17 -fsyntax-only -I. RustraJSIBridge.cpp 2>&1 | head -20`

진짜 jsi/jsi.h가 없어 링크는 안 되지만 `-fsyntax-only`도 헤더 경로 문제로 실패할 수 있다. 그 경우 최소 검증으로 `test-jsi-shim.hpp`를 include 강제:

```bash
cd examples/react-native-calculator/modules/rustra-jsi/ios
clang++ -std=c++17 -fsyntax-only -I. -include test-jsi-shim.hpp RustraJSIBridge.cpp 2>&1 | head -20
```

shim이 런타임 헤더만 모킹하므로 브릿지 전체 컴파일이 안 될 수 있다 — 그 경우 **수정 정확성은 코드 리뷰 + grep으로 검증**하고 실제 컴파일은 iOS CI 잡(rn-ios가 xcodebuild로 컴파일)에 맡긴다. grep 검증:

```bash
grep -n "makeInvoke(" examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp
# 기대: 12줄 전부 4-인수 시그니처 (fn, freeFn, err)
grep -c "rustra_calculator_free_buffer" examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp
# 기대: 기존 9 + 신규 9 = 18 이상
```

**Step 4: Commit**

```bash
git add examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp
git commit -m "fix(rn): makeInvoke 심볼별 free 함수 매칑 — calculator 응답 호출당 누수·8B 언더리드 수정"
git commit --amend --no-edit  # lefthook prettier 재스테이징 (필요 시)
```

---

### Task 2: calculator rkyv V2 sync 진입점 panic guard

**Files:**
- Modify: `examples/calculator/src/lib.rs:1099-1119` (`rustra_calculator_invoke_rkyv_v2`)
- Test: `examples/calculator/tests/`에 신규 파일

**Step 1: 실패 테스트 작성 — 패닉하는 핸들러가 abort 없이 에러 프레임으로 변환되는지**

Create: `examples/calculator/tests/rkyv_v2_panic_guard.rs`

calculator 패키지에 패닉하는 정적 명령이 없으므로, **핸들러 패닉을 유도하는 대신 최소 검증**으로 (a) 기존 명령 정상 왕복이 panic guard 추가 후에도 동작, (b) guard 경로 자체는 코어 `with_panic_guard`와 동일 패턴임을 코드로 증명한다. 패닉 유도 테스트가 가능한 이유: `invoke_rkyv_v2`의 fallback JSON 경로에서 `command.rkyv_v2_decode`가 잘린 페이로드로 `Err`를 반환하는 것은 이미 payload_robustness가 커버. **진짜 패닉 테스트는 동적 등록으로 가능하다** — debug 빌드에서 패닉하는 핸들러를 등록하고 FFI를 호출:

```rust
//! rkyv V2 FFI 진입점의 panic guard 검증 — 핸들러 패닉이 extern "C" 경계를
//! 넘지 않고 rkyv V2 에러 프레임(ok=0)으로 변환되는지 확인한다.
#![allow(clippy::bool_assert_comparison)]

use serde_json::json;
use serde::{Deserialize, Serialize};

/// 패닉하는 핸들러를 가진 별도 패키지 — calculator 전역 패키지를 오염하지 않는다.
/// rustra_ffi_set_package 로 일시적으로 스왑했다가 원복한다 (전역 뮤텍스로 직렬화).
#[path = "../benches/common.rs"]
mod common;

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct BoomInput { n: i64 }

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct BoomOutput { value: i64 }

fn panicking_package() -> rustra::Package {
    use rustra::prelude::*;
    #[command]
    fn boom(input: BoomInput) -> Result<BoomOutput> {
        let _ = input;
        panic!("intentional handler panic for panic-guard test");
    }
    rustra::build!("test.panic", boom).done()
}

static SWAP_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

extern "C" {
    fn rustra_calculator_invoke_rkyv_v2(
        payload: *const u8, payload_len: usize, out_len: *mut usize,
    ) -> *mut u8;
    fn rustra_calculator_free_buffer(ptr: *mut u8, len: usize);
}

#[test]
fn handler_panic_becomes_error_frame_not_abort() {
    let _guard = SWAP_MUTEX.lock().unwrap_or_else(|p| p.into_inner());
    // (스왑 API가 코어에 없으면 이 테스트는 calculator 명령으로 대체 불가 —
    //  대신 패닉 핸들러를 가진 패키지를 FFI 전역에 설치하는 public API 사용.
    //  코어 rustra::ffi 에 set_package_for_test 가 없다면 Task 2 구현에서
    //  #[cfg(feature)] 없이 pub fn install 을 쓰거나, calculator 빌드에
    //  패닉 테스트 전용 hidden 명령을 추가하는 방법을 택한다 — 아래 Step 3 참조.)
    todo!("구현 단계에서 스왑 전략 확정")
}
```

**주의 — Step 1 대안 채택 (단순화):** 코어에 전역 패키지 스왑 API가 없다면 테스트 유도가 복잡해진다. **권장: calculator 예제에 패닉 전용 히든 명령을 추가하지 않고**, `crates/rustra` 단위 테스트로 우회한다 — `with_panic_guard`가 이미 코어에서 테스트되어 있으므로, calculator 측 수정은 "같은 헬퍼를 쓴다"는 정도다. 따라서 **테스트는 컴파일·기존 회귀로 갈음**:

Create: `examples/calculator/tests/rkyv_v2_panic_guard.rs` (단순화 버전)

```rust
//! rkyv V2 sync/async FFI panic guard 회귀 테스트.
//!
//! 핸들러 패닉 직접 유도는 전역 패키지 스왑이 필요해 예제 크레이트에서
//! 불가능하다. 대신 (1) 정상 왕복이 guard 추가에 영향받지 않는지, (2) 잘린
//! 페이로드가 여전히 clean 에러 프레임(ok=0, code 추출 가능)인지 검증한다.
//! 패닉→에러프레임 변환 자체는 rustra::ffi::with_panic_guard 의 코어
//! 테스트(crates/rustra/src/ffi.rs tests)가 담보한다.

use rustra::prelude::*;

extern "C" {
    fn rustra_calculator_invoke_rkyv_v2(
        payload: *const u8, payload_len: usize, out_len: *mut usize,
    ) -> *mut u8;
    fn rustra_calculator_free_buffer(ptr: *mut u8, len: usize);
}

#[path = "../src/wire_common.rs"]
mod wire_common; // 없으면 인라인: add 요청 인코딩 헬퍼 (postcard [a i64 LE varint][b])

/// calculator add 명령의 cmd_id (rustra build! 등록순 — 1번).
const CMD_ADD: u16 = 1;

fn invoke_rkyv_v2(payload: &[u8]) -> Vec<u8> {
    let mut out_len = 0usize;
    let ptr = unsafe {
        rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
    };
    assert!(!ptr.is_null(), "FFI returned null");
    let out = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
    unsafe { rustra_calculator_free_buffer(ptr, out_len) };
    out
}

#[test]
fn normal_roundtrip_still_works() {
    // [cmd_id u16 LE][a varint][b varint] — postcard i64 는 varint.
    let mut req = vec![];
    req.extend_from_slice(&CMD_ADD.to_le_bytes());
    postcard::to_io(&(42i64, 58i64), &mut req).unwrap();
    let resp = invoke_rkyv_v2(&req);
    assert_eq!(resp.first(), Some(&1), "ok flag");
}

#[test]
fn truncated_payload_is_clean_error_frame() {
    let resp = invoke_rkyv_v2(&[CMD_ADD as u8, 0]); // 본문 없음
    assert_eq!(resp.first(), Some(&0), "error flag — abort 되지 않음");
}
```

`postcard`는 calculator Cargo.toml에 이미 있다. cmd_id가 1이 아니면 `examples/calculator/src/lib.rs`의 `rustra::build!` 등록 순서를 확인해 상수를 맞춘다 (기존 `tests/wire_fixtures.rs`에 같은 방식의 핀 fixture가 있으니 참조).

**Step 2: 테스트 실행 — 수정 전에는 통과해야 함(회귀 방지용)**

Run: `cargo test -p rustra-calculator-example --test rkyv_v2_panic_guard 2>&1 | tail -5`
Expected: PASS (2 tests). panic guard 추가 전에도 이 테스트는 통과한다 — 이 테스트는 **수정 후 회귀 방지**용이며, guard 미설치 자체는 abort 위험이라 컴파일러가 못 잡는다. (패닉 유도 테스트의 공백은 Step 4의 통합 패닉 테스트로 메운다.)

**Step 3: catch_unwind 구현**

`examples/calculator/src/lib.rs:1110-1116`의 `get_package()...invoke_rkyv_v2(bytes)` 호출을 guard로 감싼다:

```rust
    // panic guard — 코어 with_panic_guard 와 동일 계약: 핸들러 패닉이
    // extern "C" (nounwind) 경계를 넘으면 프로세스 abort 다. 에러 프레임으로
    // 변환한다 (crates/rustra/src/ffi.rs 참조).
    let resp_bytes = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        rustra::ffi::get_package()
            .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))
            .and_then(|pkg| pkg.invoke_rkyv_v2(bytes))
    })) {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => rustra::encode_rkyv_v2_error(&error),
        Err(panic) => rustra::encode_rkyv_v2_error(&RustraError::custom(
            "internal",
            &format!("panic in handler: {}", panic_message(&panic)),
        )),
    };

    alloc_response(resp_bytes, out_len)
```

같은 파일에 panic 메시지 추출 헬퍼를 추가 (코어 ffi.rs:265-271과 동일 구현):

```rust
/// panic payload 에서 메시지 추출 — 코어 ffi::panic_message 와 동일.
fn panic_message(panic: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = panic.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = panic.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}
```

`RustraError::custom`의 두 번째 인자가 `impl Into<String>`인지 `&str`인지 `crates/rustra/src/error.rs`에서 확인 후 맞춘다 (`pub fn custom(code, detail: impl Display)` 패턴이면 `format!` 결과를 그대로).

**Step 4: 코어 수준 통합 패닉 테스트 (진짜 패닉 유도)**

패닉 유도는 코어에서 가능하다 — `crates/rustra/tests/` 에 `invoke_rkyv_v2` 패닉 핸들러 패키지를 만들고 `Package::invoke_rkyv_v2`를 직접 호출 (FFI 전역 불필요). 코어 `invoke_rkyv_v2`(lib.rs:766)는 handler panic 시 `catch_unwind` 없이 전파하므로 **코어도 수정 대상이다**: `crates/rustra/src/lib.rs:793-807`의 `with_state_context` 클로저를 `catch_unwind`로 감싼다.

Create: `crates/rustra/tests/rkyv_v2_panic.rs`

```rust
//! Package::invoke_rkyv_v2 의 핸들러 패닉 전파 검증 — 패닉은 Err(RustraError)로
//! 정규화되어야 하고 절대 unwinding 을 호출자에게 새어나가지 않는다
//! (FFI 진입점에서 abort 로 이어지기 때문).
#![allow(clippy::bool_assert_comparison)]

use rustra::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct BoomInput { n: i64 }

#[derive(Debug, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct BoomOutput { value: i64 }

#[command]
fn boom(input: BoomInput) -> Result<BoomOutput> {
    let _ = input;
    panic!("intentional");
}

#[test]
fn handler_panic_is_contained_as_internal_error() {
    let pkg = rustra::build!("test.panic", boom).done();
    // cmd_id 1 요청 프레임: [1u16 LE][n varint] — postcard 필드 순서.
    let mut req = Vec::new();
    req.extend_from_slice(&1u16.to_le_bytes());
    postcard::to_io(&1i64, &mut req).unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pkg.invoke_rkyv_v2(&req)
    }));
    match result {
        Ok(Err(e)) => assert_eq!(e.code(), "internal", "panic normalized: {e:?}"),
        Ok(Ok(_)) => panic!("panicking handler must not succeed"),
        Err(_) => panic!("panic escaped invoke_rkyv_v2 — would abort at extern C"),
    }
}
```

`RustraError`에 `code()` 접근자가 없으면(`code`가 private) `e.to_string()`이 `"internal: ..."`로 시작하는지로 검증:

```rust
        Ok(Err(e)) => assert!(e.to_string().starts_with("internal"), "got: {e}"),
```

**Step 5: 코어 invoke_rkyv_v2에 guard 적용**

`crates/rustra/src/lib.rs:793`의 `with_state_context(&self.states, || {...})` 블록 전체를 감싼다:

```rust
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            with_state_context(&self.states, || {
                // (기존 본문 그대로: fast path / fallback)
                ...
            })
        }));
        match outcome {
            Ok(result) => result,
            Err(panic) => Err(RustraError::internal(format!(
                "panic in handler: {}",
                crate::ffi::panic_message(&panic)
            ))),
        }
```

`panic_message`가 ffi 비공개면(`fn panic_message` private) `pub(crate)`로 승격하거나 lib.rs에 로컬 헬퍼를 복제한다. `RustraError::internal`의 retryable=false가 에러 프레임으로 인코딩되어 JS에 `internal` 코드로 도달한다.

**Step 6: 전체 게이트 실행**

```bash
cargo test -p rustra -p rustra-calculator-example 2>&1 | grep -E "test result" 
# 기대: 전부 ok
cargo test -p rustra --test rkyv_v2_panic 2>&1 | tail -3
# 기대: 1 passed
npm run lint:rust && npm run fmt:rust:check
# 기대: 통과
```

**Step 7: Commit**

```bash
git add crates/rustra/src/lib.rs crates/rustra/tests/rkyv_v2_panic.rs examples/calculator/src/lib.rs examples/calculator/tests/rkyv_v2_panic_guard.rs
git commit -m "fix(ffi): rkyv V2 디스패치 패닉 가드 — 핸들러 패닉을 internal 에러 프레임으로 정규화(abort 방지)"
```

---

### Task 3: async 워커 panic guard + cancel 레지스트리 누수 방지

**Files:**
- Modify: `examples/calculator/src/lib.rs:1139-1179` (`rustra_calculator_invoke_rkyv_v2_async`)
- Test: `examples/calculator/tests/rkyv_v2_panic_guard.rs` (Task 2 파일에 추가)

**Step 1: 실패 테스트 — async 패닉 시 on_complete가 에러 프레임으로 발화하는지**

`examples/calculator/tests/rkyv_v2_panic_guard.rs`에 추가:

```rust
extern "C" {
    fn rustra_calculator_invoke_rkyv_v2_async(
        payload: *const u8, payload_len: usize,
        user_data: *mut std::ffi::c_void,
        on_complete: Option<
            unsafe extern "C" fn(*mut std::ffi::c_void, *mut u8, usize),
        >,
        invocation_id: *mut u64,
    );
}

static ASYNC_DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
static ASYNC_IS_ERROR: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

unsafe extern "C" fn async_cb(_ud: *mut std::ffi::c_void, resp: *mut u8, len: usize) {
    if !resp.is_null() && len > 0 {
        let bytes = std::slice::from_raw_parts(resp, len);
        ASYNC_IS_ERROR.store(bytes.first() == Some(&0), std::sync::atomic::Ordering::SeqCst);
    }
    ASYNC_DONE.store(true, std::sync::atomic::Ordering::SeqCst);
}

#[test]
fn async_handler_panic_still_fires_on_complete_with_error() {
    // 패닉 핸들러가 없어 정상 명령으로 대체: 핵심 계약은 "워커가 어떤 경로로
    // 끝나도 on_complete 가 정확히 1회 발화"다. panic 유도는 코어 테스트가
    // 담보하므로 여기선 완료 보장 + 취소 레지스트리 정리를 검증한다.
    let mut req = vec![];
    req.extend_from_slice(&CMD_ADD.to_le_bytes());
    postcard::to_io(&(1i64, 2i64), &mut req).unwrap();
    let mut id: u64 = 0;
    unsafe {
        rustra_calculator_invoke_rkyv_v2_async(
            req.as_ptr(), req.len(), std::ptr::null_mut(),
            Some(async_cb), &mut id,
        );
    }
    assert_ne!(id, 0, "invocation id issued");
    // 워커 스레드 완료 대기 (최대 5초) — 패닉 시 on_complete 미발화면 여기서 타임아웃 실패.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while !ASYNC_DONE.load(std::sync::atomic::Ordering::SeqCst) {
        assert!(std::time::Instant::now() < deadline, "on_complete never fired — promise hang");
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert!(!ASYNC_IS_ERROR.load(std::sync::atomic::Ordering::SeqCst), "normal call must succeed");
    // 취소 레지스트리 정리: complete 후 상태 조회는 Unknown.
    use rustra::ffi::rustra_ffi_cancellation_status;
    assert_eq!(unsafe { rustra_ffi_cancellation_status(id) }, 0 /* Unknown */);
}
```

`rustra_ffi_cancellation_status`의 반환 매핑(0=Unknown인지)은 `crates/rustra/src/ffi.rs:715` 부근의 doc comment에서 확인 후 맞춘다. 코어 async(`rustra_ffi_invoke_async`, ffi.rs:515)에도 같은 누수가 있는지 확인하고 있으면 동일하게 수정한다(워커 클로저에 catch_unwind + complete 보장).

**Step 2: 테스트 실행 — Task 3 수정 전에는 통과해야 함 (회귀 기준선)**

Run: `cargo test -p rustra-calculator-example --test rkyv_v2_panic_guard -- async 2>&1 | tail -3`
Expected: PASS.

**Step 3: async 워커에 catch_unwind + complete 보장 구현**

`examples/calculator/src/lib.rs:1157-1179`의 `std::thread::spawn` 클로저를 수정:

```rust
    std::thread::spawn(move || {
        // panic guard — 워커가 패닉으로 죽으면 (a) complete_invocation 미호출로
        // 취소 레지스트리가 영구히 남고 (b) on_complete 미발화로 JS 프라미스가
        // 영구 hang 한다. 어떤 경로로든 정확히 1회 on_complete 를 보장한다.
        let resp = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if rustra::cancel::status(id) == rustra::cancel::Status::Cancelled {
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
            }
        })) {
            Ok(resp) => resp,
            Err(panic) => rustra::encode_rkyv_v2_error(&RustraError::custom(
                "internal",
                &format!("panic in async handler: {}", panic_message(&panic)),
            )),
        };
        rustra::cancel::complete_invocation(id);
        if let Some(cb) = on_complete {
            let mut out_len = 0;
            let ptr = alloc_response(resp, &mut out_len);
            unsafe { cb(user_data_raw as *mut std::ffi::c_void, ptr, out_len) };
        }
    });
```

**Step 4: 코어 async 엔트리 동일 검사**

`crates/rustra/src/ffi.rs:612-684` (`rustra_ffi_invoke_async` / `rustra_ffi_invoke_json_async`)의 워커 클로저를 읽어: dispatch에 `catch_unwind`이 있고(515행 확인됨) `complete_invocation`이 패닉 경로에서도 호출되는지 확인. dispatch는 guard 안에 있지만 `complete_invocation`이 guard 밖 조기 return 뒤에만 있다면 scope-guard 패턴으로 이동:

```rust
// complete 보장 — defer 패턴 (러스트 표준만 사용)
struct EnsureComplete(u64);
impl Drop for EnsureComplete {
    fn drop(&mut self) { rustra::cancel::complete_invocation(self.0); }
}
let _ensure = EnsureComplete(id);
```

`complete_invocation`이 멱등(없는 id 제거 no-op)이므로 정상 경로 이중 호출도 안전하다 — `crates/rustra/src/cancel.rs:64`의 `remove`가 멱등임을 확인한다.

**Step 5: 게이트 실행**

```bash
cargo test -p rustra -p rustra-calculator-example 2>&1 | grep -E "test result"
# 기대: 전부 ok (기존 cancel_tests 포함)
npm run lint:rust
```

**Step 6: Commit**

```bash
git add crates/rustra/src/ffi.rs examples/calculator/src/lib.rs examples/calculator/tests/rkyv_v2_panic_guard.rs
git commit -m "fix(ffi): async 워커 패닉 가드 + 취소 레지스트리 완료 보장 — on_complete 1회 보장(JS hang 방지)"
```

---

### Task 4: JSI extractBytes 클램프 (OOB 읽기 방어)

**Files:**
- Modify: `examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp:48-65`

**Step 1: 클램프 구현**

`extractBytes`의 TypedArray 분기(56-62행)에 경계 검사를 추가:

```cpp
  auto bufferProp = obj.getProperty(rt, "buffer");
  if (bufferProp.isObject() && bufferProp.asObject(rt).isArrayBuffer(rt)) {
    auto buf = bufferProp.asObject(rt).getArrayBuffer(rt);
    double offsetNum = obj.getProperty(rt, "byteOffset").asNumber();
    double lengthNum = obj.getProperty(rt, "byteLength").asNumber();
    // 클램프 — JS 가 건넨 byteOffset/byteLength 는 임의 값일 수 있다(duck-typed
    // 객체 통과). buf 범위 밖이면 OOB 읽기가 된다: 명시적 에러로 거부한다.
    if (!(offsetNum >= 0) || !(lengthNum >= 0)) { // NaN 도 거부
      throw JSError(rt, "RustraJSI: invalid byteOffset/byteLength (negative or NaN)");
    }
    size_t bufSize = buf.size(rt);
    auto byteOffset = static_cast<size_t>(offsetNum);
    auto byteLength = static_cast<size_t>(lengthNum);
    if (byteOffset > bufSize || byteLength > bufSize - byteOffset) {
      throw JSError(rt, "RustraJSI: byteOffset/byteLength out of buffer bounds");
    }
    return {buf.data(rt) + byteOffset, byteLength};
  }
```

또한 `asNumber()`이 객체/undefined일 때 JSError를 던지는지 확인한다(던지면 그대로 전파, 아니면 `isNumber()` 선검사 추가). `double→size_t` 캐스트 전 `offsetNum <= SIZE_MAX` 상한 검사도 추가(1e9 등 정상 범위 밖은 위 클램프에서 잡힘).

**Step 2: 컴파일/리뷰 검증 (Task 1 Step 3과 동일하게 shim 컴파일 시도, 불가 시 grep)**

```bash
grep -n "byteOffset > bufSize" examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp
# 기대: 1 히트
```

**Step 3: Commit**

```bash
git add examples/react-native-calculator/modules/rustra-jsi/ios/RustraJSIBridge.cpp
git commit -m "fix(rn): extractBytes TypedArray 클램프 — duck-typed byteOffset/byteLength OOB 읽기 거부"
```

---

### Task 5: InvokeOptions timeout 옵션 (JS hang 탈출)

**Files:**
- Modify: `packages/types/src/index.ts` (InvokeOptions + createRkyvV2Engine + 타임아웃 레이스)
- Test: `packages/types/src/index.test.ts`에 추가

**Step 1: 실패 테스트 작성**

`packages/types/src/index.test.ts`에 추가 (파일 상단 import에 `AbortSignal.timeout` 사용 가능 — Node 18+):

```ts
test('invoke rejects with transport.timeout when engine never settles', async () => {
  // 영원히 settle하지 않는 엔진 + 50ms 타임아웃
  const hanging: EngineClient = {
    invoke: () => new Promise(() => {}), // never settles
  };
  await assert.rejects(
    invokeWithTimeout(hanging, 'addNumbers', { a: 1, b: 2 }, { timeoutMs: 50 }),
    (err: unknown) => {
      assert.ok(err instanceof RustraCommandError);
      assert.equal((err as RustraCommandError).code, 'transport.timeout');
      assert.equal((err as RustraCommandError).retryable, true);
      return true;
    },
  );
});

test('invoke timeout races with late success — late result ignored, no unhandled rejection', async () => {
  let resolveLate!: (v: unknown) => void;
  const slow: EngineClient = {
    invoke: () => new Promise((res) => { resolveLate = res; }),
  };
  await assert.rejects(
    invokeWithTimeout(slow, 'x', undefined, { timeoutMs: 30 }),
    /transport\.timeout/,
  );
  resolveLate(1); // 지각 도착 — unhandled rejection 없이 무시되어야 함
  await new Promise((r) => setTimeout(r, 10));
});
```

테스트 헬퍼 `invokeWithTimeout`는 이번 Task에서 `packages/types` 공개 API로 추가하는 함수다. `RustraCommandError`/`EngineClient`는 파일 기존 import 재사용.

**Step 2: 테스트 실행 — 실패 확인**

Run: `npm run build -w @rustra/types && node --test packages/types/dist/index.test.js 2>&1 | tail -5`
Expected: FAIL — `invokeWithTimeout is not defined` (함수 미구현).

**Step 3: 구현**

`packages/types/src/index.ts`의 `InvokeOptions`(44-47행 부근)에 필드 추가:

```ts
export type InvokeOptions = {
  /** (T1) AbortSignal — abort 시 Promise 를 즉시 reject 하고, 네이티브가
   *  invokeAsync/invokeCancel 을 노출하면 취소를 전파한다. */
  signal?: AbortSignal;
  /**
   * (프로덕션 준비) 호출별 타임아웃(ms). 만료 시 `transport.timeout`
   * (retryable)으로 reject 한다. 네이티브가 응답하지 않는 hang(워커 패닉,
   * FFI 데드락 등)의 유일한 JS 측 탈출구다. 지각 응답은 무시된다.
   */
  timeoutMs?: number;
};
```

같은 파일에 공개 헬퍼 + 글로벌 invoke 통합:

```ts
/**
 * 엔진 호출에 타임아웃 레이스를 건다. `options.timeoutMs` 가 없으면 엔진
 * 호출을 그대로 반환한다(오버헤드 0). 타임아웃은 settle 경쟁이며 지각 응답은
 * 무시된다 — 엔진이 나중에 reject 해도 unhandled rejection 이 되지 않도록
 * 뒤늦은 프라미스에 no-op catch 를 단다.
 */
export async function invokeWithTimeout<T>(
  engine: EngineClient,
  command: string,
  args?: unknown,
  options?: InvokeOptions,
): Promise<T> {
  const p = Promise.resolve(engine.invoke<T>(command, args, options));
  const ms = options?.timeoutMs;
  if (ms === undefined) return p;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new RustraCommandError(
            'transport.timeout',
            `invoke("${command}") timed out after ${ms}ms`,
            true,
          ));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  // 참고: race 에서 진 초과 프라미스 p 는 여기서 이미 참조가 사라지지만,
  // p 가 나중에 reject 되면 unhandled rejection 이 된다 — 사전에 흡수:
}
```

unhandled absorption이 필요하므로 최종 형태:

```ts
export async function invokeWithTimeout<T>(
  engine: EngineClient,
  command: string,
  args?: unknown,
  options?: InvokeOptions,
): Promise<T> {
  const p = Promise.resolve(engine.invoke<T>(command, args, options));
  const ms = options?.timeoutMs;
  if (ms === undefined) return p;
  // 지각 reject 흡수 — race 에서 졌어도 프라미스는 살아있어 unhandled
  // rejection 이 될 수 있다. no-op catch 로 흡수한다.
  const guarded = p.catch(() => undefined as unknown as T);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new RustraCommandError(
            'transport.timeout',
            `invoke("${command}") timed out after ${ms}ms`,
            true,
          ));
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void guarded; // 흡수용 참조 유지
  }
}
```

기존 글로벌 `invoke`(243행 부근)도 옵션을 그대로 넘기므로, `createRkyvV2Engine`의 invoke 반환 지점에 이 레이스를 적용한다 — 엔진 내부보다는 **글로벌 invoke에서 일괄 적용**이 DRY다:

```ts
// 기존:
  return _engine.invoke<T>(command, args, options);
// 변경:
  return invokeWithTimeout(_engine, command, args, options) as Promise<T>;
```

타입 정합에 유의(`invokeWithTimeout` 제네릭). `invokeBatch`(271행)에도 동일 적용.

**Step 4: 테스트 통과 확인**

Run: `npm run build -w @rustra/types && node --test packages/types/dist/index.test.js 2>&1 | tail -3`
Expected: PASS (기존 67 + 신규 2).

**Step 5: 문서 갱신**

`docs/compatibility-matrix.md`와 `docs/rust-api-guide.md:404` 근처 에러 코드 표에 `timeoutMs` 한 줄 추가 (매트릭스 문서가 이미 취소/시그널 표를 갖고 있으므로 같은 형식으로).

**Step 6: Commit**

```bash
git add packages/types/src/index.ts packages/types/src/index.test.ts docs/compatibility-matrix.md docs/rust-api-guide.md
git commit -m "feat(types): InvokeOptions.timeoutMs — transport.timeout(retryable) 타임아웃 레이스, JS hang 탈출구"
```

---

### Task 6: 코드젠 식별자 화이트리스트

**Files:**
- Modify: `packages/cli/src/index.ts:486-510` (`parsePackageSchema`)
- Test: `packages/cli/src/generate.test.ts`에 추가

**Step 1: 실패 테스트 작성**

`packages/cli/src/generate.test.ts`에 추가 (기존 import 구조 재사용 — `parsePackageSchema`가 index.ts 비공개 함수이므로 **공개 export 필요**. 먼저 index.ts에서 `export { parsePackageSchema }` 추가하는 게 본 Task의 일부):

```ts
import { parsePackageSchema } from './index.js';

test('parsePackageSchema rejects hostile identifiers', () => {
  const base = {
    packageId: 'ok.pkg',
    schemaVersion: 1,
    commands: [
      {
        name: 'addNumbers', commandId: 1,
        inputType: 'AddInput', outputType: 'AddOutput',
        inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
      },
    ],
  };
  // 정상 통과
  parsePackageSchema(base);

  // 악의적 타입명 — 생성 TS에 그대로 삽입되는 식별자
  for (const bad of ['Evil { $ }', 'X; import("fs")', 'A\\n}; //']) {
    assert.throws(
      () => parsePackageSchema({ ...base, commands: [{ ...base.commands[0], inputType: bad }] }),
      /identifier/,
    );
  }
  // 정의 키(definitions)도 검증 대상
  assert.throws(
    () => parsePackageSchema({
      ...base,
      commands: [{ ...base.commands[0], definitions: { 'bad key!': { type: 'object' } } }],
    }),
    /identifier/,
  );
});
```

CLI 테스트 러너가 `tsx` 등으로 src를 직접 실행하는지 `packages/cli/package.json`의 `test` 스크립트를 확인하고, `./index.js` import가 `./index.ts`로 표기되어야 하면 맞춘다(기존 generate.test.ts의 import 방식을 그대로 따름).

**Step 2: 테스트 실패 확인**

Run: `npm run test -w @rustra/cli 2>&1 | tail -5`
Expected: FAIL — 현재는 악의적 식별자를 그대로 통과시킴.

**Step 3: 구현**

`packages/cli/src/index.ts`의 `parsePackageSchema`(486행)에 화이트리스트 추가:

```ts
/** TS 식별자로 안전한 문자열만 허용 — 생성 코드에 그대로 삽입되는 이름의
 * 주입 방어. $ 허용은 JS 식별자 규격 준수. */
const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function assertIdentifier(value: string, where: string): void {
  if (!TS_IDENTIFIER.test(value)) {
    throw new Error(`Invalid schema: ${where} must be a plain identifier, got: ${JSON.stringify(value)}`);
  }
}
```

`parsePackageSchema` 루프에 삽입 (기존 검사 뒤):

```ts
    assertIdentifier(cmd.name, `commands[${i}].name`);
    if (cmd.inputType !== '()') assertIdentifier(cmd.inputType, `commands[${i}].inputType`);
    if (cmd.outputType !== '()') assertIdentifier(cmd.outputType, `commands[${i}].outputType`);
    if (cmd.definitions) {
      for (const key of Object.keys(cmd.definitions)) {
        assertIdentifier(key, `commands[${i}].definitions key`);
      }
    }
```

`parsePackageSchema`를 export 목록(29-30행 부근)에 추가. 또한 생성 코드에 삽입되는 `command.name` 문자열 리터럴(generate.ts:104 `'${command.name}'`)은 홑따옴표 이스케이프 처리: `command.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")` — 식별자 검사를 통과하면 불필요하므로 생략 가능(화이트리스트가 더 강함).

**Step 4: 테스트 통과 + 전체 회귀**

Run: `npm run test -w @rustra/cli 2>&1 | tail -3`
Expected: PASS.

Run: `npm run test:ts:node 2>&1 | tail -3` (기존 생성 클라이언트 회귀)
Expected: PASS — 정상 스키마(calculator/crud)는 전부 식별자 규격 내라 통과.

**Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/generate.test.ts
git commit -m "fix(cli): 스키마 식별자 화이트리스트 — 생성 TS 코드 주입 방어(inputType/outputType/definitions 키)"
```

---

### Task 7: 버전 드리프트 수정 — 단일 소스 주입

**Files:**
- Modify: `packages/cli/src/index.ts:130-145, 190-210` (init 템플릿)
- Modify: `README.md:21,246`, `docs/getting-started.md:27`
- Modify: `package.json` (루트 version), `examples/reference-app/package.json`

**Step 1: init 템플릿을 빌드 시점 버전 주입으로 전환**

`packages/cli/src/index.ts`의 init 템플릿(136-144행 Cargo.toml, 190-210행 package.json)에서 하드코딩 버전을 CLI 자기 버전으로 교체. CLI 패키지 버전은 런타임에 읽을 수 없는 게 아니라 — npm workspace에서 `process.env.npm_package_version`는 신뢰 불가(npx 실행 시 없음). **단일 소스는 packages/cli/package.json**이므로 빌드 산출에 버전을 심는다:

`packages/cli`의 `tsconfig` 빌드产物에 버전을 주입하는 가장 단순한 방법 — generate 시점 조회:

```ts
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
// CLI 자신의 package.json — 워크스페이스에서 dist 기준 상대 경로.
const cliVersion: string = require_('../../package.json').version as string;
```

(napi 테스트 하네스가 같은 패크 `createRequire`를 이미 씀 — transport-bench.test.ts:62 참조. 배포 레이아웃: `dist/index.js`에서 `../../package.json` = packages/cli/package.json. 확인: packages/cli는 dist/flat 구조 — `dist/index.js` → `../package.json`이 정답일 수 있으니 실제 배포 files 구조를 보고 맞춘다: files가 `["dist"]`면 package.json과 dist가 같은 레벨 → `require_('../package.json')`.)

템플릿의 버전 문자열 교체:

```ts
// Cargo.toml 템플릿 내:
rustra = "^${cliMajorVersion}"
rustra-macros = "^${cliMajorVersion}"
// 여기서 cliMajorVersion = cliVersion.split('.').slice(0, 2).join('.')  // "0.2"
// package.json 템플릿 devDependencies 내:
"@rustra/cli": `^${cliVersion}`,
"@rustra/types": `^${cliVersion}`,
```

crates.io/npm 동시 범프 관례(워크스페이스 0.2.0 = npm 0.2.0)가 이미 성립하므로 CLI 버전에서 파생하면 다음 범프에서 자동 따라온다.

**Step 2: 검증 테스트**

`packages/cli/src/generate.test.ts` 또는 신규 `init.test.ts`:

```ts
test('init template versions derive from CLI package version', async () => {
  // init 을 임시 디렉터리에 실행하고 생성 파일 검사 (기존 init 테스트가
  // 있다면 그 하네스 재사용 — generate.test.ts 의 init 테스트 패턴 확인).
  const out = await mkdtemp(join(tmpdir(), 'rustra-init-'));
  await runInit(out); // CLI init 함수 (index.ts export 여부 확인, 미export면 main 우회)
  const cargo = await readFile(join(out, 'Cargo.toml'), 'utf8');
  const pkg = JSON.parse(await readFile(join(out, 'package.json'), 'utf8'));
  const cliPkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const minor = cliPkg.version.split('.').slice(0, 2).join('.');
  assert.match(cargo, new RegExp(`rustra = "\\^?${minor}`));
  assert.equal(pkg.devDependencies['@rustra/types'], `^${cliPkg.version}`);
});
```

기존 init 테스트 하네스가 있으면 그 컨벤션에 맞춘다 (`grep -n "init" packages/cli/src/*.test.ts`).

**Step 3: 문서 버전 핀 수정**

```bash
# README.md:21 — rustra = "0.1" → "0.2"
# README.md:246 — version = "0.1" → "0.2"
# docs/getting-started.md:27 — rustra = "0.1" → "0.2"
```

sed보다 Edit 도구로 정확히 3곳만 교체 (getting-started.md:47, 407의 path 의존성은 건드리지 않음).

**Step 4: 루트/예제 버전 정합**

- `package.json`(루트) version `0.1.3` → `0.2.0` (private이라 발행 무영향, 혼란 제거)
- `examples/reference-app/package.json`: version 0.1.3→0.2.0, 의존성 `^0.1.3` → `^0.2.0` (4곳)
- `examples/reference-app` 이 루트 README examples/ 목록에 미등록이면 한 줄 추가: `reference-app/          @rustra/react 훅 레퍼런스 앱 (useCommand/useMutation/useEvent)`

**Step 5: 전체 검증**

```bash
npm run test -w @rustra/cli 2>&1 | tail -3
npm run test:ts:node 2>&1 | tail -3   # reference-app typecheck 포함 여부 확인
grep -rn 'rustra = "0.1"' README.md docs/getting-started.md  # 기대: 0 hits
grep -n "0\.1\.3" packages/cli/src/index.ts  # 기대: 0 hits
```

**Step 6: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/src/generate.test.ts README.md docs/getting-started.md package.json package-lock.json examples/reference-app/package.json
git commit -m "fix(version): init 템플릿 버전 단일 소스 주입 + 문서 0.2 핀 정합 + 루트/reference-app 범프"
```

---

### Task 8: napi 에러 코드 보존

**Files:**
- Modify: `examples/calculator-napi/src/lib.rs:5-20`
- Test: `examples/calculator/ts/transport-bench.test.ts` 옆에 신규 (또는 payload-robustness.test.ts에 추가)

**Step 1: 실패 테스트 작성**

`examples/calculator/ts/payload-robustness.test.ts`에 추가 (napi 바이너리 존재 시에만 실행 — 기존 `runningUnderBunTest`/`existsSync(napiPath)` 패턴 재사용):

```ts
test('napi: typed error code crosses the wire (capability.denied)', async () => {
  const napiPath = join(ROOT, `examples/calculator-napi/calculator-napi.${process.platform}-${process.arch}.node`);
  if (!existsSync(napiPath)) return; // 바이너리 없으면 스킵 (CI: build:napi 사전 빌드)
  const native = createRequire(import.meta.url)(napiPath) as {
    rustraInvoke: (cmd: string, args: string | undefined) => string;
  };
  // calculator auth 예제가 아니므로 확정 에러 명령 사용: 없는 명령 → command.not_found
  assert.throws(
    () => native.rustraInvoke('definitelyNotACommand', JSON.stringify({})),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      // code 보존 후: "command.not_found: ..." 형식 (parseRustraErrorString 규약)
      assert.match(msg, /^command\.not_found: /);
      return true;
    },
  );
});
```

테스트 파일 최상단 import에 `existsSync`, `createRequire`, `join`, `ROOT` 없으면 추가 (transport-bench.test.ts에서 복사).

**Step 2: 현재 동작 확인 (실패)**

Run: `npm run build:napi && npx tsc -p examples/calculator/tsconfig.json && node --test dist-ts/examples/calculator/ts/payload-robustness.test.js 2>&1 | tail -5`
Expected: FAIL — 현재 `e.to_string()`은 `"command.not_found: ..."`(Display)라 **통과할 수도 있다**. Display가 이미 `code: message` 형식이므로(자체 파서 `parseRustraErrorString`이 이 형식을 파싱) **이 수정의 실제 가치는 retryable 보존**이다. 테스트를 retryable로 조준 변경:

```ts
      // JSON 와이어 형식이면 code+retryable 모두 보존된다
      assert.match(msg, /\{.*"code"\s*:\s*"command\.not_found"/);
```

즉 napi가 `Error::from_reason(serde_json::to_string(&e))`(RustraError는 Serialize 유도됨 — error.rs:34)로 JSON 문자열을 심으면, JS `parseRustraErrorString`(types/index.ts:88)이 code/message/retryable을 복원한다. **현재는 to_string()이라 plain `"command.not_found: ..."`만 가므로 retryable=true(재시도 가능 에러의 경우)가 유실된다.** command.not_found는 retryable=false라 이 테스트는 통과할 수 있으니, retryable=true 케이스를 유도하려면 payload.too_large(대형 args)를 쓴다:

```ts
  // payload.too_large는 retryable=false지만 코드 보존 검증엔 충분.
  // retryable=true 케이스는 transport.timeout이 napi 경로에 없어 단순화:
  // 핵심은 code 필드가 JSON으로 구조 보존되는지다.
  assert.throws(
    () => native.rustraInvoke('addNumbers', JSON.stringify({ a: 1, b: 2, pad: 'x'.repeat(2 * 1024 * 1024) })),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.match(msg, /"code"\s*:\s*"payload\.too_large"/, `code not preserved: ${msg}`);
      return true;
    },
  );
```

(`max_payload_bytes` 기본 1MiB — napi 엔트리에서 게이트하는지 확인, 안 하면 JS 측 사전 검사만 있으므로 이 테스트 명령을 invalid_json 경로로 조정. 구현 Step 3에서 napi에 크기 게이트가 없으면 args 파싱 실패 `invalid_args`를 코드로 검증하는 것으로 대체 — 핵심은 JSON 구조 보존.)

**Step 3: 구현 — RustraError를 JSON으로 직렬화해 reason에 심기**

`examples/calculator-napi/src/lib.rs`:

```rust
/// RustraError → napi Error: 코드/retryable 이 유실되지 않도록 JSON 문자열로
/// 직렬화해 reason 에 심는다. JS 측 parseRustraErrorString(@rustra/types)이
/// { code, message, retryable } 을 복원한다 — plain Display(to_string)는
/// retryable 을 버린다.
fn napi_error(e: rustra::RustraError) -> Error {
    let wire = serde_json::to_string(&e).unwrap_or_else(|_| e.to_string());
    Error::from_reason(wire)
}
```

`invoke_json` 실패 분기(16행)를 `.map_err(napi_error)`로 교체. `serde_json`은 이미 의존성에 있다. `RustraError`가 `rustra` 재수출인지 확인(`pub use error::RustraError`) — 아니면 `rustra::RustraError` 경로 수정.

**Step 4: JS 측 파이프라인 확인**

`packages/node/src/index.ts:63-67`의 catch가 `'code' in e` 객체만 선호하므로, napi Error의 message(JSON 문자열)를 파싱하려면 `createNapiTransport` 계열에서 `parseRustraErrorString(e.message)`를 호출하도록 보강 — `packages/node/src/index.ts`의 catch 블록:

```ts
      } catch (e: unknown) {
        if (typeof e === 'object' && e !== null && 'code' in e && 'message' in e) {
          const err = e as { code: string; message: string };
          throw new RustraCommandError(err.code, err.message);
        }
        // napi/rust Display 또는 JSON 와이어 문자열 — parseRustraErrorString 이
        // { code, message, retryable } JSON 과 "code: message" 양쪽을 복원한다.
        if (e instanceof Error) throw parseRustraErrorString(e.message);
        throw new RustraCommandError('unknown', String(e));
      }
```

`parseRustraErrorString`을 `@rustra/types`에서 import (이미 재수출 확인 — types index.ts export 목록).

**Step 5: 게이트 실행**

```bash
npm run build:napi 2>&1 | tail -2
npx tsc -p examples/calculator/tsconfig.json && node --test dist-ts/examples/calculator/ts/payload-robustness.test.js 2>&1 | tail -3
npm run test:packages 2>&1 | tail -3
```

**Step 6: Commit**

```bash
git add examples/calculator-napi/src/lib.rs examples/calculator/ts/payload-robustness.test.ts packages/node/src/index.ts
git commit -m "fix(napi): RustraError JSON 와이어 보존 — code/retryable이 JS까지 구조 전달, parseRustraErrorString 파이프라인 연결"
```

---

### Task 9: transport-bench 플래키 테스트 안정화

**Files:**
- Modify: `examples/calculator/ts/transport-bench.test.ts:110-124, 24-26`

**Step 1: 실패 재현 확보 (기록)**

10회 반복 실행으로 실패율 기록 (이미 확인됨: 제环境 10회 중 4회 실패, avg 13.5ms vs 임계 10ms):

```bash
for i in $(seq 1 10); do node --test dist-ts/examples/calculator/ts/transport-bench.test.js 2>&1 | grep -c "^not ok"; done | sort | uniq -c
```

**Step 2: 임계 완화 — p50 기반 + 여유 폭**

벤치류 임계는 머신 부하에 강한 통계로 바꾼다. subprocess spawn 비용(~6ms p50) 대비 CI 러너 변동을 감안해:

```ts
const SUBPROCESS_MAX_AVG_US = 10000; // 삭제
// 변경: p50 기반 게이트 — avg 는 첫 실행 콜드스타트/스케줄러 지터에 민감하다.
// p50 은 그 영향을 흡수한다. 25ms 는 p50 기준값(~6ms)의 4배 여유.
const SUBPROCESS_MAX_P50_US = 25000;
// napi: p50 ~28µs → 500µs 유지(이미 17배 여유, avg 임계도 안정적이나 통일)
const NAPI_MAX_P50_US = 500;
```

`bench()` 헬퍼(28행)는 이미 p50을 반환한다. 단건 임계 어설션 교체 (110-124행):

```ts
    it('subprocess: latency within threshold (p50-based)', () => {
      const invoke = createSubprocessInvoke();
      const r = bench('subprocess', () => invoke('addNumbers', { a: 42, b: 58 }), SUBPROCESS_ITERATIONS);
      console.log(`    subprocess: avg=${r.avg.toFixed(0)}ns p50=${r.p50.toFixed(0)}ns p99=${r.p99.toFixed(0)}ns`);
      assert(
        r.p50 < SUBPROCESS_MAX_P50_US * 1000,
        `subprocess p50 ${r.p50.toFixed(0)}ns exceeds ${SUBPROCESS_MAX_P50_US}µs threshold`,
      );
    });
```

napi 임계(137-147행)도 같은 방식으로 p50 교체. `napi-rs is faster than subprocess`(149-171행) 비교 어설션은 유지 — 이 비교는 절대 임계가 아니라 상대 비교라 안정적이다.

추가 안정화: `SUBPROCESS_ITERATIONS = 50`(23행)을 100으로 올려 p50 표본 강화 (런타임 +~0.7s).

**Step 3: 반복 검증**

```bash
npx tsc -p examples/calculator/tsconfig.json
for i in $(seq 1 10); do node --test dist-ts/examples/calculator/ts/transport-bench.test.js 2>&1 | grep -cE "^not ok"; done | sort | uniq -c
# 기대: 10회 전부 0
```

**Step 4: Commit**

```bash
git add examples/calculator/ts/transport-bench.test.ts
git commit -m "test: transport-bench 임계 p50 기반 전환 — CI 러너 부하로 인한 플래키 제거"
```

---

### Task 10: 커버리지 도입 (cargo llvm-cov + c8)

**Files:**
- Create: `.github/workflows/coverage.yml`
- Modify: `package.json` (script), 루트 `Cargo.toml` 불필요 (llvm-cov는 커맨드라인 플래그)

**Step 1: 로컬 llvm-cov 설정 확인**

```bash
rustup component add llvm-tools-preview
cargo install cargo-llvm-cov --locked
cargo llvm-cov -p rustra --lcov --output-path lcov.info 2>&1 | tail -3
```

`lcov.info`에서 코어 커버리지 요약 확인 (콘솔 보고서로 숫자 기록).

**Step 2: CI workflow 작성**

Create: `.github/workflows/coverage.yml`

```yaml
name: Coverage

# advisory — 게이트가 아니라 가시화. 수치가 안정되면(2-3주) PR 코멘트/임계 도입.
on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  rust:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: llvm-tools-preview
      - uses: Swatinem/rust-cache@v2
      - run: cargo install cargo-llvm-cov --locked
      - name: Generate lcov
        run: cargo llvm-cov -p rustra -p rustra-macros --lcov --output-path lcov.info
      - name: Summary
        run: cargo llvm-cov -p rustra --summary-only 2>&1 | tail -5 >> $GITHUB_STEP_SUMMARY
      - uses: actions/upload-artifact@v4
        with:
          name: rust-lcov
          path: lcov.info

  typescript:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - name: Build + test with c8
        run: |
          npm run build
          npx c8 --reporter=text --reporter=lcov \
            node --test packages/node/dist/index.test.js packages/bun/dist/index.test.js \
            packages/tauri/dist/index.test.js packages/react-native/dist/index.test.js \
            packages/testing/dist/index.test.js packages/devtools/dist/index.test.js \
            packages/react/dist/index.test.js 2>&1 | tail -20 >> $GITHUB_STEP_SUMMARY
      - uses: actions/upload-artifact@v4
        with:
          name: ts-lcov
          path: coverage/lcov.info
```

c8은 `npx`로 즉시 실행( devDependency 추가 불필요 — CI에서만 쓰면 devDep 추가가 더 재현 가능: `npm i -D c8`을 루트에 하고 script로 등록).

**Step 3: 루트 script 등록**

`package.json` scripts에:

```json
    "coverage:rust": "cargo llvm-cov -p rustra -p rustra-macros --summary-only",
    "coverage:ts": "c8 --reporter=text node --test packages/node/dist/index.test.js packages/bun/dist/index.test.js packages/tauri/dist/index.test.js packages/react-native/dist/index.test.js packages/testing/dist/index.test.js packages/devtools/dist/index.test.js packages/react/dist/index.test.js"
```

`npm i -D c8@latest` (루트 devDependencies — changesets 대상 아님, 루트 private).

**Step 4: 워크플로 문법 검증**

```bash
# 액션 시뮬레이션 없이 YAML 파스만
node -e "require('js-yaml'); console.log('ok')" 2>/dev/null || npx --yes js-yaml .github/workflows/coverage.yml > /dev/null && echo "YAML valid"
```

(push 후 Actions 탭에서 실제 기동 확인 — 수동 dispatch로 1회 트리거 가능한지는 권한에 따라 사용자가 승인 필요하면 안내만.)

**Step 5: Commit**

```bash
git add .github/workflows/coverage.yml package.json package-lock.json
git commit -m "ci: 커버리지 가시화 — cargo llvm-cov + c8, advisory Step summary"
```

---

### Task 11: fuzz 운영 강화 (시드 corpus 커밋 + postcard 타깃)

**Files:**
- Create: `fuzz/fuzz_targets/invoke_postcard.rs`
- Modify: `.github/workflows/fuzz.yml`, `.gitignore:35`
- Create: `fuzz/corpus/invoke_rkyv_v2/*.bin` (시드), `fuzz/corpus/invoke_postcard/*.bin`

**Step 1: postcard 타깃 작성**

기존 `invoke_rkyv_v2.rs` 타깃을 참고해 create:

```rust
#![no_main]
//! rustra_ffi_invoke_postcard 퍼징 — postcard 엔벨로프 디코드 경계 검증.
//! rkyv V2 타깃이 코어 invoke_rkyv_v2 를 직접 때리는 것과 달리, 이 타깃은
//! FFI 진입(extern "C") 을 포함한 전체 경로를 무작위 입력으로 때린다 —
//! panic guard/size gate/free 짝이 실제 ABI 경계에서 성립하는지 확인.

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let mut out_len = 0usize;
    // 등록된 패키지가 없으면 not_registered 에러 프레임 — 그 자체로 clean path.
    let ptr = unsafe { rustra::ffi::rustra_ffi_invoke_postcard(data.as_ptr(), data.len(), &mut out_len) };
    if !ptr.is_null() {
        unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };
    }
});
```

`rustra_ffi_invoke_postcard`가 전역 패키지를 필요로 하므로, calculator처럼 로컬 패키지를 등록하는 헬퍼가 필요하다면 `fuzz/Cargo.toml`의 rustra 의존성으로 `#[command]` 패키지를 만들어 `rustra_ffi_*` 전역에 등록한다 — 기존 `invoke_rkyv_v2.rs`가 이미 이 패턴(파일 하단의 패키지 등록)을 쓰는지 확인하고 그대로 따른다. 등록 API가 퍼블릭하지 않으면 타깃을 `Package::invoke_postcard` 직접 호출로 조정한다.

**Step 2: 시드 corpus 생성 + 커밋**

```bash
cd fuzz
mkdir -p corpus/invoke_rkyv_v2 corpus/invoke_postcard
# rkyv V2: 기존 유닛/통합 테스트의 pin 프레임을 시드로
# addNumbers(a=42,b=58): cmd_id=1 + postcard varint
printf '\x01\x00\x2a\x3a' > corpus/invoke_rkyv_v2/add_42_58
# 잘린 프레임/에러 케이스
printf '\x01\x00' > corpus/invoke_rkyv_v2/truncated
printf '\xff\xff\xff\xff' > corpus/invoke_rkyv_v2/unknown_cmd
# payload_robustness.rs 의 hex fixture 들을 추가 시드로 (파일에서 추출)
grep -rh "hex!" ../crates/rustra/tests/payload_robustness.rs | head -5
```

`.gitignore:35`의 `fuzz/corpus/` 라인 삭제 → `fuzz/corpus/*/_*` 식으로 유지하려면 cargo-fuzz가 생성하는 배치 서브디렉터리만 무시:

```gitignore
# fuzz corpus — 시드(손으로 심은 파일)는 커밋, cargo-fuzz 축적분(corpus/*/ *) 은 제외
fuzz/corpus/**/*.tmp
fuzz/corpus/**/crashes/
fuzz/corpus/**/slow_units/
```

정확한 무시 패턴은 `cargo fuzz` 아티팩트 레이아웃(artifact/crash/스냅샷은 `artifacts/`) 확인 후 최소화 — 핵심은 **식별 가능한 이름의 시드 파일은 커밋**되는 것.

**Step 3: fuzz.yml 확장**

```yaml
      - name: Fuzz invoke_rkyv_v2 (10min)
        run: cd fuzz && cargo fuzz run invoke_rkyv_v2 corpus/invoke_rkyv_v2 -- -max_total_time=480 -max_len=1024
      - name: Fuzz invoke_postcard (5min)
        run: cd fuzz && cargo fuzz run invoke_postcard corpus/invoke_postcard -- -max_total_time=240 -max_len=1024
      - name: Upload crash artifacts
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: fuzz-crash-${{ github.run_id }}
          path: fuzz/artifacts/
          if-no-files-found: ignore
      - name: Open issue on crash
        if: failure()
        uses: actions/github-script@v7
        with:
          script: |
            await github.rest.issues.create({
              owner: context.repo.owner,
              repo: context.repo.repo,
              title: `fuzz: crash in scheduled run (${context.runId})`,
              body: `아티팩트: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
              labels: ['fuzz', 'bug'],
            });
```

`continue-on-error: true`는 유지하되(실험 성격), 이슈 자동 등록으로 드리프트 방지. `permissions: issues: write` 잡 레벨 추가 필요.

**Step 4: 로컬 스모크 (1분 스케일)**

```bash
cd fuzz && cargo fuzz run invoke_postcard corpus/invoke_postcard -- -max_total_time=30 -max_len=512 2>&1 | tail -3
# 기대: crash 없음, corpus 축적
```

**Step 5: Commit**

```bash
git add fuzz/fuzz_targets/invoke_postcard.rs fuzz/corpus .github/workflows/fuzz.yml .gitignore fuzz/Cargo.toml fuzz/Cargo.lock
git commit -m "ci(fuzz): postcard FFI 타깃 + 시드 corpus 커밋 + 크래시 자동 이슈 등록"
```

---

### Task 12: crates.io 메타데이터 + npm 패키지 위생

**Files:**
- Modify: `Cargo.toml` (workspace.package), `crates/rustra/Cargo.toml`, `crates/rustra-macros/Cargo.toml`
- Modify: `packages/*/package.json` (sideEffects, engines), `packages/types/tsconfig.json`, `packages/react/tsconfig.json`
- Modify: `packages/types/package.json`, `packages/react/package.json` (test 파일 dist 제외 방식)

**Step 1: workspace 메타데이터 추가**

루트 `Cargo.toml` `[workspace.package]`에:

```toml
[workspace.package]
edition = "2024"
license = "MIT"
version = "0.2.0"
description = "Rust → TypeScript bridge framework with auto-generated type-safe clients"
repository = "https://github.com/loopy-lim/rustra"
# 신규 — crates.io 검색성/발행 경고 제거
homepage = "https://github.com/loopy-lim/rustra"
documentation = "https://docs.rs/rustra"
keywords = ["typescript", "bridge", "codegen", "ffi", "react-native"]
categories = ["api-bindings", "development-tools::ffi"]
rust-version = "1.85"  # edition 2024 요구 최소 — 명시해 MSRV 계약화
```

`crates/rustra/Cargo.toml`에 상속 추가:

```toml
homepage.workspace = true
documentation.workspace = true
keywords.workspace = true
categories.workspace = true
rust-version.workspace = true
```

`rustra-macros`도 동일 (documentation는 docs.rs 공유 — macros는 `documentation` 생략 가능, proc-macro는 docs.rs 별도 페이지 없음).

주의: crates.io keywords는 **소문자+하이픈**만 허용(대문자 불가), 최대 5개. categories는 공식 슬러그여야 함(`api-bindings`, `development-tools::ffi` 존재 확인: <https://crates.io/category_slugs> — `development-tools::ffi` 실재함).

**Step 2: npm sideEffects/engines**

전 패키지 `packages/*/package.json`에:

```json
  "sideEffects": false,
```

`@rustra/node`와 `@rustra/cli`에:

```json
  "engines": { "node": ">=18" },
```

(CLI는 bin — node 18 하한이 npm workspaces 및 node --test 지원과 정합.)

**Step 3: 테스트 파일 dist 동봉 제거**

`test:types`/`test:packages`(package.json:15-16)가 `dist/index.test.js`를 실행하므로 **컴파일은 유지**하되 발행에서만 제외. 방법: `files`를 정밀화한다:

```json
  "files": [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/index.js.map",
    "dist/index.d.ts.map"
  ]
```

(`@rustra/types`는 단일 진입점 — index만 있음. `@rustra/react`도 확인: hooks 등 다수 파일이면 `dist/*.js`/`dist/*.d.ts` 글로브 + `!dist/*.test.*` 는 npm files 지원 안 하므로 개별 열거. 파일 수가 많으면 대안: tsconfig `exclude: ["src/**/*.test.ts"]`로 아예 컴파일에서 제외 + 테스트 실행은 `test:types`에서 `tsc -p tsconfig.test.json` 별도 구성. **후자 권장** — 아래 Step 4.)

**Step 4: (권장) tsconfig 테스트 분리 — types/react**

`packages/types/tsconfig.json`에:

```json
{
  "compilerOptions": { ... 기존 ... },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts"]
}
```

Create: `packages/types/tsconfig.test.json`:

```json
{
  "extends": "./tsconfig.json",
  "exclude": []
}
```

루트 `package.json` `test:types` 스크립트 수정:

```json
    "test:types": "tsc -p packages/types/tsconfig.test.json && node --test packages/types/dist/index.test.js",
```

(기존이 `npm run build -w @rustra/types && node --test ...` — build(발행용, 테스트 제외)와 test-compile(테스트 포함)을 분리. `test:packages`의 다른 패키지(node/bun/tauri/react-native/testing/devtools)도 같은 누수가 있는지 `npm pack --dry-run`으로 점검 후 동일 적용 — react만 3.5kB 누수 확인됨, types도 d.ts/map 포함.)

`npm run build`(발행)은 테스트 제외로 줄고, `npm pack --dry-run`에서 test 파일이 사라지는지 검증:

```bash
cd packages/react && npm pack --dry-run 2>&1 | grep -c "test" ; cd ../..
# 기대: 0
```

**Step 5: changeset 추가**

발행 대상 변화(패키지 메타데이터)는 changeset 필요 — `.changeset/`에 신규:

```md
---
"@rustra/types": patch
"@rustra/react": patch
"@rustra/node": patch
"@rustra/cli": patch
"@rustra/bun": patch
"@rustra/tauri": patch
"@rustra/react-native": patch
"@rustra/testing": patch
"@rustra/devtools": patch
---

chore: 패키지 메타데이터 위생 — sideEffects/engines 선언, 발행 dist에서 테스트 파일 제외
```

(Rust 크레이트는 changesets 관리 밖 — Cargo.toml 수정은 다음 `cargo publish` 시 반영.)

**Step 6: 게이트 실행**

```bash
cargo publish -p rustra-macros --dry-run --allow-dirty 2>&1 | grep -iE "warning|error" | head -5
# 기대: metadata 경고 소멸 (네트워크 검증은 --dry-run 로컬만)
npm run build && npm run test:packages 2>&1 | tail -3
npm run test:types 2>&1 | tail -3
```

**Step 7: Commit**

```bash
git add Cargo.toml crates/rustra/Cargo.toml crates/rustra-macros/Cargo.toml packages/*/package.json packages/types/tsconfig.json packages/types/tsconfig.test.json packages/react/tsconfig.json .changeset/
git commit -m "chore(meta): crates.io 메타데이터(keywords/categories/MSRV) + npm sideEffects/engines + 발행 dist 정화"
```

---

### Task 13: 브랜치 보호 설정 (수동 단계 — 사용자 참여)

**Files:** 없음 (GitHub 설정). 문서로만 기록.

**Step 1: required checks 지정 (사용자 gh 권한으로)**

현재 `gh api repos/loopy-lim/rustra/branches/main/protection` → 404 (보호 없음). 사용자에게 안내하거나 관리자 권한이 있으면:

```bash
gh api -X PUT repos/loopy-lim/rustra/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": true,
    "contexts": [
      "rust-audit",
      "rust (ubuntu-latest, stable)",
      "rust (macos-latest, stable)",
      "rust (windows-latest, stable)",
      "typescript",
      "rn-android",
      "rn-ios",
      "consumer-smoke"
    ]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
EOF
```

context 이름은 실제 CI 잡의 체크 런 이름과 정확히 일치해야 한다 — 첫 PR에서 `/repos/.../commits/<sha>/check-runs`로 실제 이름을 확인한 뒤 확정. **이 단계는 외부 변경(저장소 설정)이므로 사용자 승인 후 실행한다.**

**Step 2: docs/release-procedure.md에 한 줄 기록**

```md
## 브랜치 보호
main 은 required checks(rust-audit/rust 3OS/typescript/rn-android/rn-ios/consumer-smoke)로 보호된다. 새 CI 잡 추가 시 context 목록에도 추가한다.
```

**Step 3: Commit (문서만)**

```bash
git add docs/release-procedure.md
git commit -m "docs: 브랜치 보호 정책 기록 — required checks 목록"
```

---

### Task 14: 최종 통합 검증 + changeset

**Step 1: 전체 게이트 실행**

```bash
cargo fmt --all -- --check && npm run lint:rust 2>&1 | tail -2
cargo test 2>&1 | grep -E "test result" | awk '{s+=$4; f+=$6} END {print "passed:",s," failed:",f}'
# 기대: failed: 0
npm run build
npm run test 2>&1 | tail -5   # types + ts:node + packages + cli 전체
npm run format:check && npm run lint
npm run audit:prod
```

**Step 2: 기능 수정 changeset 추가**

`.changeset/`에 (Task 12의 것과 별도):

```md
---
"@rustra/types": minor
"@rustra/node": patch
"@rustra/cli": patch
---

feat: InvokeOptions.timeoutMs — transport.timeout(retryable) 타임아웃 레이스. hang(네이티브 무응답)의 JS 측 탈출구. 스키마 식별자 화이트리스트로 생성 코드 주입 방어. napi 경로 에러 code/retryable JSON 보존.
```

minor 범프 사유: `timeoutMs`는 신규 옵션 필드(단, 선택적이라 patch도 무방 — 사용자 정책에 맞게 조정).

**Step 3: git 상태 확인 + 최종 커밋**

```bash
git status --short   # 놓친 파일 없는지
git log --oneline -10
```

**Step 4: PR 생성 (사용자 승인 후)**

브랜치 `fix/production-readiness-audit`로 Push + PR. PR 본문에 감사 결과 표(결함 4 + 조건부 7)와 각 Task 매핑 첨부.

---

## 검증 체크리스트 (완료 정의)

| 항목 | 검증 명령 | 기대 |
|---|---|---|
| 누수 수정 | grep makeInvoke 4-인수 | 12 심볼 전부 deleter 매칭 |
| panic guard | `cargo test -p rustra --test rkyv_v2_panic` | 1 passed |
| async 완료 보장 | panic_guard 테스트 async 항목 | on_complete 1회 + registry 정리 |
| JSI 클램프 | grep byteOffset 클램프 | 존재 |
| timeout | types 테스트 신규 2건 | transport.timeout + retryable |
| 식별자 화이트리스트 | CLI 테스트 | hostile 거부 |
| 버전 | grep "0.1" 문서/템플릿 | 0 히트 |
| napi 코드 | payload-robustness 신규 | `"code":` JSON 매치 |
| 플래키 | transport-bench 10회 | 0 실패 |
| 커버리지 | coverage.yml dispatch | Step summary 생성 |
| fuzz | cargo fuzz 30s 스모크 | crash 없음 |
| 메타데이터 | cargo publish --dry-run | 경고 소멸 |
| 브랜치 보호 | gh api protection | 200 |
| 전체 게이트 | npm run test + cargo test | 전부 green |

## Task 의존 관계

- Task 1, 4 (JSI C++) — 독립, 병렬 가능
- Task 2, 3 (calculator/코어 panic guard) — Task 3이 Task 2의 테스트 파일에 추가하므로 **순차**
- Task 5 (timeout), 6 (식별자), 7 (버전), 8 (napi), 9 (플래키) — 서로 독립
- Task 10, 11 (CI) — 독립
- Task 12 (메타데이터) — Task 7의 버전 작업 이후 권장(충돌 회피)
- Task 13 (브랜치 보호) — 사용자 승인 필요, 코드와 독립
- Task 14 — 마지막
