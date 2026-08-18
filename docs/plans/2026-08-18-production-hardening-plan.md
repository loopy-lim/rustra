# Production Hardening Implementation Plan (4트랙)

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** rustra-bridge에 취소 파이프라인 · OTA 명령별 폴백 · 동적 페이로드 한도 · 크로스 플랫폼 CI 매트릭스를 추가해 프로덕션 투입 가능 상태로 만든다.

**Architecture:** Rust FFI 레이어(crates/rustra/src/ffi.rs)에 취소 레지스트리·동적 한도·이름 라우팅 폴백을 추가하고, JS 엔진 허브(packages/types/src/index.ts)에 AbortSignal/옵트인 폴백/사전 검사를 배선한다. CI는 rust 잡을 3-OS 매트릭스로 확장한다. 각 트랙은 독립 커밋으로 분리되고 풀 테스트 스위트가 매 트랙 종료 시 green이어야 한다.

**Tech Stack:** Rust 1.95 (no new deps — std만 사용), TypeScript (packages/*), GitHub Actions.

**설계 문서:** `docs/plans/2026-08-18-production-hardening-design.md`

**공통 함정 (전 태스크 적용):**
- lefthook pre-commit이 rustfmt/prettier를 실행하지만 **재스테이징하지 않는다** — 커밋 후 `git status`에 변경이 남으면 `git commit -am --no-verify -m "style: fmt"`로 amend.
- FFI 전역 상태(`PACKAGE: OnceLock`) 때문에 FFI 테스트는 **각자 별도 테스트 바이너리**여야 한다 (payload_robustness.rs 패턴 참고).
- 생성물 `crates/generated/`, `examples/*/generated/`는 prettier 대상 아님.
- 전체 회귀: `cargo test -p rustra && npm run test:types && npm run test:ts:node && npm run test:packages`.

---

## 트랙 1: AbortSignal ↔ CancellationToken 취소 파이프라인

### Task 1: Rust 취소 레지스트리 (cancel.rs)

**Files:**
- Create: `crates/rustra/src/cancel.rs`
- Modify: `crates/rustra/src/lib.rs:114` (`mod cancel;` 추가)
- Test: `crates/rustra/src/cancel.rs` (inline #[cfg(test)])

**Step 1: Write the failing test**

`crates/rustra/src/cancel.rs` 하단에:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_returns_unique_ids() {
        let a = register_invocation();
        let b = register_invocation();
        assert_ne!(a, b);
    }

    #[test]
    fn cancel_transitions_running_to_cancelled() {
        let id = register_invocation();
        assert!(cancel_invocation(id), "cancelling a Running invocation succeeds");
        assert!(!cancel_invocation(id), "second cancel is a no-op");
    }

    #[test]
    fn complete_then_cancel_is_noop() {
        let id = register_invocation();
        complete_invocation(id);
        assert!(!cancel_invocation(id), "cannot cancel a Completed invocation");
    }

    #[test]
    fn status_reflects_lifecycle() {
        let id = register_invocation();
        assert_eq!(status(id), Status::Running);
        cancel_invocation(id);
        assert_eq!(status(id), Status::Cancelled);
        complete_invocation(id);
        assert_eq!(status(id), CompletedRemovedSentinel, "completed entries are removed");
    }

    #[test]
    fn unknown_id_is_unknown_status() {
        assert_eq!(status(999_999), Status::Unknown);
    }

    #[test]
    fn registry_is_cleared_on_completion() {
        let id = register_invocation();
        complete_invocation(id);
        assert_eq!(status(id), Status::Unknown, "completion removes the entry");
    }
}
```

주의: `CompletedRemovedSentinel`는 `Status::Unknown`과 동치로 테스트하면 된다 — 완료 시 엔트리 제거가 핵심 계약이므로 그렇게 단순화한다:

```rust
    #[test]
    fn status_reflects_lifecycle() {
        let id = register_invocation();
        assert_eq!(status(id), Status::Running);
        cancel_invocation(id);
        assert_eq!(status(id), Status::Cancelled);
        complete_invocation(id);
        assert_eq!(status(id), Status::Unknown, "completion removes the entry");
    }
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p rustra --lib cancel 2>&1 | tail -5`
Expected: FAIL — `unresolved module` (cancel.rs 미생성이면 lib.rs mod 추가 전이므로 컴파일 에러).

**Step 3: Write minimal implementation**

`crates/rustra/src/cancel.rs`:

```rust
//! Invocation 취소 레지스트리 — 트랙 1 (AbortSignal ↔ Rust).
//!
//! `rustra_ffi_invoke_async` 로 시작된 호출에 발급된 invocation_id 로
//! 협력적 취소(cooperative cancellation)를 지원한다:
//!
//! - `register_invocation` — 새 ID 발급 + `Running` 등록
//! - `cancel_invocation`   — `Running` → `Cancelled` 전환 (스레드 강제 종료 없음)
//! - `complete_invocation` — 엔트리 제거 (레지스트리 누수 방지)
//! - `status`              — 핸들러 내부 폴링용 상태 조회
//!
//! 취소는 플래그 전환만 한다. 진행 중인 핸들러 스레드를 죽이지 않고,
//! dispatch 체크포인트(capability 게이트 직후 / 핸들러 완료 후)에서
//! `Cancelled` 여부를 확인해 `RustraError::cancelled` 로 응답한다.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

/// 취소 대상 호출의 현재 상태.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// 알 수 없는 ID (완료 후 제거됐거나 발급된 적 없음).
    Unknown,
    /// 워커가 실행 중.
    Running,
    /// cancel 호출됨 — 다음 체크포인트에서 중단된다.
    Cancelled,
}

enum Entry {
    Running,
    Cancelled,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static REGISTRY: Mutex<BTreeMap<u64, Entry>> = Mutex::new(BTreeMap::new());

/// 새 invocation을 등록하고 고유 ID를 발급한다.
pub fn register_invocation() -> u64 {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    REGISTRY
        .lock()
        .unwrap()
        .insert(id, Entry::Running);
    id
}

/// `Running` → `Cancelled` 전환. 취소 성공 시 true.
/// 이미 취소됐거나(멱등 no-op) 완료/알 수 없는 ID면 false.
pub fn cancel_invocation(id: u64) -> bool {
    let mut registry = REGISTRY.lock().unwrap();
    match registry.get_mut(&id) {
        Some(Entry::Running) => {
            *registry.get_mut(&id).unwrap() = Entry::Cancelled;
            true
        }
        _ => false,
    }
}

/// 호출 완료 — 레지스트리에서 엔트리를 제거한다 (누수 방지).
pub fn complete_invocation(id: u64) {
    REGISTRY.lock().unwrap().remove(&id);
}

/// 현재 상태 조회. 완료된(제거된) 호출은 `Unknown` 이다.
pub fn status(id: u64) -> Status {
    match REGISTRY.lock().unwrap().get(&id) {
        Some(Entry::Running) => Status::Running,
        Some(Entry::Cancelled) => Status::Cancelled,
        None => Status::Unknown,
    }
}
```

`crates/rustra/src/lib.rs` 모듈 선언부(`mod codegen;` 근처, lib.rs:114)에 추가:

```rust
pub mod cancel;
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p rustra --lib cancel 2>&1 | tail -5`
Expected: `test result: ok. 6 passed`

**Step 5: Commit**

```bash
git add crates/rustra/src/cancel.rs crates/rustra/src/lib.rs
git commit -m "feat(cancel): invocation 취소 레지스트리 (T1)"
```

---

### Task 2: `RustraError::cancelled` 에러 코드

**Files:**
- Modify: `crates/rustra/src/error.rs:60` 근처 (새 생성자)
- Modify: `crates/rustra/src/error.rs:19` 근처 (문서 테이블)
- Test: `crates/rustra/tests/cancel_tests.rs` (Task 3에서 함께 작성하므로 여기선 error.rs inline 테스트)

**Step 1: Write the failing test**

`crates/rustra/src/error.rs` 하단 inline test에 추가:

```rust
#[cfg(test)]
mod cancelled_tests {
    use super::*;

    #[test]
    fn cancelled_error_is_retryable_with_stable_code() {
        let e = RustraError::cancelled("aborted by AbortSignal");
        assert_eq!(e.code(), "cancelled");
        assert_eq!(e.message(), "aborted by AbortSignal");
        assert!(e.is_retryable(), "cancelled means the caller gave up on this attempt, not the operation");
    }
}
```

**Step 2: Run test to verify it fails**

Run: `cargo test -p rustra --lib cancelled 2>&1 | tail -5`
Expected: FAIL — `no function or associated item named 'cancelled' found`

**Step 3: Write minimal implementation**

`RustraError` impl 블록에 (`timeout` 생성자 뒤, error.rs:121 근처):

```rust
    /// 호출이 취소됨 — AbortSignal/cancel 로 호출자가 포기한 경우.
    /// Code: `cancelled`. Retryable (재시도 시 정상 동작 가능).
    pub fn cancelled(detail: impl fmt::Display) -> Self {
        Self {
            code: "cancelled",
            message: detail.to_string(),
            retryable: true,
        }
    }
```

모듈 상단 에러 코드 테이블(error.rs:19 근처)에 행 추가:

```rust
//! | `cancelled` | [`cancelled`] | 호출 취소 (AbortSignal 등) |
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p rustra --lib cancelled 2>&1 | tail -3`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/rustra/src/error.rs
git commit -m "feat(cancel): RustraError::cancelled 에러 코드 (T1)"
```

---

### Task 3: FFI 취소 심볼 3종 + async 시그니처 확장

**Files:**
- Modify: `crates/rustra/src/ffi.rs:436-501` (async 진입점 2종에 invocation_id out-param)
- Modify: `crates/rustra/src/ffi.rs` FFI 주석 블록(ffi.rs:1-11)에 심볼 목록 추가
- Create: `crates/rustra/tests/cancel_tests.rs`

**주의:** async 시그니처 변경은 C ABI break다. 현재 유일 호출자는 방금 커밋한 우리 자신(호스트 예제 미사용)이므로 안전하게 변경한다. ABI 안정성이 필요해지면 별도 `*_v2` 심볼로 분리한다(지금은 YAGNI).

**Step 1: Write the failing test**

`crates/rustra/tests/cancel_tests.rs`:

```rust
//! 트랙 1 — FFI 취소 파이프라인 (별도 바이너리: OnceLock 전역 격리).

use rustra::Package;
use rustra::ffi::{
    rustra_ffi_cancellation_status, rustra_ffi_free, rustra_ffi_invoke_async,
    rustra_ffi_invoke_cancel, rustra_ffi_set_max_payload,
};
use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

#[path = "../benches/common.rs"]
mod common;

fn cancellation_package() -> Package {
    // start_signal 을 set 하기 전까지 블록하는 무거운 명령 —
    // cancel 이 Running 상태에서 도달하는 것을 증명한다.
    static RELEASE: OnceLock<Mutex<()>> = OnceLock::new();
    static STARTED: AtomicBool = AtomicBool::new(false);
    let _ = RELEASE.set(Mutex::new(()));

    Package::builder("cancel.test")
        .command("blocking", move |input: common::AddInput| {
            let _guard = RELEASE.get().unwrap().lock().unwrap();
            STARTED.store(true, Ordering::SeqCst);
            common::add(input)
        })
        .build()
}

struct Completion {
    data: Vec<u8>,
}

static RECEIVED: OnceLock<Mutex<Option<Completion>>> = OnceLock::new();

unsafe extern "C" fn on_complete(_user: *mut c_void, ptr: *mut u8, len: usize) {
    let slice = std::slice::from_raw_parts(ptr, len);
    let data = slice.to_vec();
    rustra_ffi_free(ptr, len);
    *RECEIVED.get().or_init(|| Mutex::new(None)).lock().unwrap() = Some(Completion { data });
}

#[test]
fn async_invoke_emits_invocation_id_and_cancel_stops_handler() {
    let pkg = cancellation_package();
    pkg.register_ffi();
    let _ = RECEIVED.set(Mutex::new(None));

    // postcard envelope { command: "blocking", args_json: "{\"a\":1,\"b\":2}" }
    let envelope = postcard::to_allocvec(&("blocking".to_string(), "{\"a\":1,\"b\":2}".to_string())).unwrap();
    // 주의: FfiPostcardEnvelope 필드명이 {command, args_json} 이므로
    // 실제 테스트에선 serde 구조체를 그대로 정의해 인코딩한다 (아래 참고).

    let mut invocation_id: u64 = 0;
    unsafe {
        rustra_ffi_invoke_async(
            envelope.as_ptr(),
            envelope.len(),
            std::ptr::null_mut(),
            Some(on_complete),
            &mut invocation_id,
        );
    }
    assert!(invocation_id > 0, "FFI must issue a non-zero invocation id");

    // 취소 — Running 상태에서만 성공.
    let cancelled = unsafe { rustra_ffi_invoke_cancel(invocation_id) };
    assert!(cancelled, "cancel on a Running invocation returns true");

    // 상태 조회 (핸들러 폴링용 공개 API).
    assert_eq!(unsafe { rustra_ffi_cancellation_status(invocation_id) }, 2); // 2 = Cancelled

    // 취소된 호출의 응답은 cancelled 에러 — on_complete 콜백으로 전달된다.
    // (블로킹 핸들러가 cancel 체크포인트에서 중단하는 것은 Task 4 의
    //  dispatch 통합 후 완전해진다. 여기선 심볼 계약만 검증.)
}
```

위 `postcard::to_allocvec` 인코딩은 테스트 dev-dependency에 postcard가 이미 있으므로 그대로 쓰되, envelope 구조체를 테스트 파일에 정의한다:

```rust
#[derive(serde::Serialize)]
struct TestEnvelope {
    command: String,
    args_json: String,
}
```

실제 인코딩: `postcard::to_allocvec(&TestEnvelope { command: "blocking".into(), args_json: "{\"a\":1,\"b\":2}".into() }).unwrap()`.

**Step 2: Run test to verify it fails**

Run: `cargo test -p rustra --test cancel_tests 2>&1 | tail -5`
Expected: FAIL — 컴파일 에러 (`rustra_ffi_invoke_async` 매개변수 개수 불일치, `rustra_ffi_invoke_cancel` 미정의).

**Step 3: Write minimal implementation**

`crates/rustra/src/ffi.rs` — async 진입점 2종 모두 다음 시그니처로 (변경: 마지막에 `invocation_id: *mut u64` 추가):

```rust
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_async(
    payload: *const u8,
    payload_len: usize,
    user_data: *mut c_void,
    on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
    invocation_id: *mut u64,
) {
    let id = crate::cancel::register_invocation();
    if !invocation_id.is_null() {
        unsafe { *invocation_id = id };
    }
    // ... 기존 bytes 복제 로직 ...
    std::thread::spawn(move || {
        let mut out_len = 0;
        let resp_ptr = unsafe { rustra_ffi_invoke(bytes.as_ptr(), bytes.len(), &mut out_len) };
        crate::cancel::complete_invocation(id);
        if let Some(cb) = on_complete {
            unsafe { cb(user_data_raw as *mut c_void, resp_ptr, out_len); }
        }
    });
}
```

`invoke_json_async`도 동일 패턴. 신규 심볼 2종 (ffi.rs 끝, event sink 섹션 앞에):

```rust
/// 진행 중인 async 호출을 취소한다 (협력적).
///
/// `Running` 상태의 호출만 취소 가능 — 이미 완료/취소된 ID는 false 반환.
/// 취소는 플래그 전환만 하고 스레드를 강제 종료하지 않는다. dispatch
/// 체크포인트에서 `cancelled` 에러로 응답된다.
///
/// # Safety
///
/// `invocation_id` 는 `rustra_ffi_invoke_async` 가 발급한 유효한 ID.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_cancel(invocation_id: u64) -> bool {
    crate::cancel::cancel_invocation(invocation_id)
}

/// 호출의 취소 상태를 조회한다 (핸들러 내부 협력적 중단 폴링용).
///
/// 반환값: 0=Unknown(완료/미발급), 1=Running, 2=Cancelled.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_cancellation_status(invocation_id: u64) -> u32 {
    match crate::cancel::status(invocation_id) {
        crate::cancel::Status::Unknown => 0,
        crate::cancel::Status::Running => 1,
        crate::cancel::Status::Cancelled => 2,
    }
}
```

ffi.rs 상단 심볼 문서 목록(ffi.rs:1-11)에 추가:

```rust
//! - `rustra_ffi_invoke_cancel`         — 진행 중 async 호출 취소 (협력적)
//! - `rustra_ffi_cancellation_status`   — 호출 취소 상태 조회 (폴링용)
```

**Step 4: Run test to verify it passes**

Run: `cargo test -p rustra --test cancel_tests 2>&1 | tail -3`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/rustra/src/ffi.rs crates/rustra/tests/cancel_tests.rs
git commit -m "feat(cancel): FFI 취소 심볼 3종 + async invocation_id 발급 (T1)"
```

---

### Task 4: dispatch 체크포인트에 취소 확인 통합

**Files:**
- Modify: `crates/rustra/src/ffi.rs` (`rustra_ffi_invoke_async` 워커 클로저 내부 — sync invoke 대신 직접 dispatch)
- Test: `crates/rustra/tests/cancel_tests.rs` (확장)

**설명:** 현재 워커는 내부에서 `rustra_ffi_invoke`(sync 전체 경로)를 호출한다. 취소 체크포인트를 넣으려면 워커가 dispatch 전에 `status(id) == Cancelled`인지 확인하고, 취소됐으면 핸들러를 실행하지 않고 `cancelled` 에러 응답을 만든다. 핸들러 완료 후 체크포인트는 첫 구현에서 제외한다 — "이미 끝난 결과 폐기"는 유용성이 낮고 복잡도만 더한다 (YAGNI; 실행 전 중단이 배터리/CPU 절약의 대부분).

**Step 1: Write the failing test**

`cancel_tests.rs`에 추가:

```rust
#[test]
fn cancelled_invocation_short_circuits_before_handler() {
    // (별도 전역 상태를 요구하므로 이 테스트는 위 테스트와 함께
    //  하나의 #[test]로 병합하거나, 패키지 id 를 바꿔 재등록한다 —
    //  OnceLock 특성상 register_ffi 는 첫 패키지만 유효.)
    // 실제 검증: cancel 호출 → on_complete 콜백의 응답 바디에
    // "cancelled" 코드 포함 + 핸들러 STARTED 플래그가 false 로 유지.
}
```

구현 상세: `cancellation_package`의 STARTED 플래그를 테스트에서 읽을 수 있도록 `pub(crate)` 가 아닌 static 공유로 재구성한다. 테스트 흐름:

1. register_ffi, invoke_async(id 수신), 즉시 cancel(id)
2. 핸들러가 release 락을 잡기 전에 cancel이 먼저 도달하도록 — invoke_json 경로의 dispatch에 워커 시작 시점 체크포인트를 배치하면 경합이 없다(워커 스레드 시작 → dispatch 직전 체크 → cancel은 메인 스레드에서 이미 완료됐다고 보장할 수 없으므로, 핸들러 락 획득 직전에도 재확인). 결정적 테스트를 위해: cancel을 먼저 호출한 뒤 invoke_async를 호출하면 워커는 시작 즉시 취소 상태를 본다.

```rust
#[test]
fn pre_cancelled_invocation_never_runs_handler() {
    let pkg = cancellation_package();
    pkg.register_ffi();
    let _ = RECEIVED.set(Mutex::new(None));

    let envelope = postcard::to_allocvec(&TestEnvelope {
        command: "blocking".into(),
        args_json: "{\"a\":1,\"b\":2}".into(),
    }).unwrap();

    // 먼저 미래의 ID 공간을 확보하지 말고 — 등록-즉시-취소가 경합 없이
    // 결정적이려면: invoke_async 로 ID 를 받고, 핸들러가 락을 대기 중인
    // 사이(STARTED == false) cancel 한다. RELEASE 락을 메인 스레드가
    // 잡고 있으면 핸들러는 블록되고, 이때 cancel → 락 반납 → 핸들러가
    // 시작 체크포인트에서 취소를 발견한다.
    drop(pkg); // 사용 명시

    let guard_holder = std::thread::spawn(|| {
        // RELEASE 락 획득 (핸들러 블록 유도)
    });

    // ... invoke_async → wait STARTED==false 상태에서 cancel → 락 반납 →
    //     on_complete 응답에 "cancelled" 포함 assert, STARTED 는 여전히 false ...
}
```

이 테스트는 경합 프리하게 설계하기 어렵다. **단순화 결정:** 핸들러 블로킹 대신, 워커 dispatch 함수의 취소 체크포인트를 `dispatch_json` 호출 **직전**에 두고, 테스트는 cancel-먼저 → invoke_async-나중 순서로 호출하면 워커는 시작 시점에 이미 Cancelled를 본다 (레지스트리에 임의 ID를 사전 등록할 수 있는 테스트 전용 경로는 없으므로, invoke_async가 ID를 반환한 직후 같은 ID에 cancel하면 워커 스레드 spawn과의 경합이 남는다). → 최종 결정: `register_invocation()`을 pub으로 유지하므로 테스트에서 직접 `cancel::register_invocation()` 후 `cancel::cancel_invocation(id)`로 Cancelled 엔트리를 만들고, 워커의 체크포인트 로직은 별도 pub(crate) 함수 `should_short_circuit(id) -> bool`로 분리해 **순수 단위 테스트**로 검증한다:

```rust
// ffi.rs (crate 내부)
pub(crate) fn dispatch_with_cancellation(id: u64, payload: &[u8]) -> Vec<u8> {
    if crate::cancel::status(id) == crate::cancel::Status::Cancelled {
        return json_serialize(&FfiResponse {
            ok: false,
            result: None,
            error: Some("cancelled: invocation was cancelled before dispatch".into()),
        });
    }
    // ... 기존 dispatch_json 경로 ...
}
```

테스트는 `should-cancel` 순수 로직 + FFI 심볼 계약(Task 3)으로 분리해 경합을 제거한다.

**Step 2: Run test to verify it fails**

Run: `cargo test -p rustra --test cancel_tests 2>&1 | tail -3`
Expected: FAIL — `dispatch_with_cancellation` 미정의.

**Step 3: Write minimal implementation**

`rustra_ffi_invoke_async`/`invoke_json_async` 워커 클로저에서 `rustra_ffi_invoke(...)` 직접 호출을 `dispatch_with_cancellation(id, &bytes)`로 교체 (응답 ptr/len 할당은 공유 헬퍼로). 상단 `pub use`/export에 `dispatch_with_cancellation` 노출 불필요 — `pub(crate)`면 테스트(`tests/` 디렉토리)에서 접근 불가하므로 **ffi 모듈을 pub로 두고 함수를 pub로** 공개한다 (다른 FFI 심볼들과 동일하게 `pub`).

**Step 4: Run test to verify it passes**

Run: `cargo test -p rustra --test cancel_tests 2>&1 | tail -3`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/rustra/src/ffi.rs crates/rustra/tests/cancel_tests.rs
git commit -m "feat(cancel): 워커 dispatch 전 취소 체크포인트 — cancelled 에러 응답 (T1)"
```

---

### Task 5: JS AbortSignal 배선 (packages/types)

**Files:**
- Modify: `packages/types/src/index.ts:441` (`createRkyvV2Engine` — invoke 옵션)
- Modify: `packages/types/src/index.ts:103` (`isRetryableCode`에 `cancelled` 추가)
- Modify: `packages/types/src/index.ts:130-162` (`RustraNative`에 `invokeCancel?` 선택 멤버)
- Test: `packages/types/src/index.test.ts`

**Step 1: Write the failing test**

`packages/types/src/index.test.ts`에 추가:

```typescript
describe('invoke AbortSignal (T1)', () => {
  function makeNative(commands: Array<[string, number]>) {
    return {
      invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer {
        // 요청의 command_id 를 그대로 에러 프레임으로 되돌리지 않고,
        // 간단히 정상 응답(tier3 ok=1) 대신 지연 없이 ok 응답 반환.
        return new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0]).buffer;
      },
      invokeCancel: mock.fn(),
    };
  }

  it('abort 전에는 signal 이 없으면 cancel 을 호출하지 않는다', async () => {
    const native = makeNative([]);
    const engine = createRkyvV2Engine(native, new Map());
    // signal 없이 invoke — cancel 미호출
    await engine.invoke('x');
    assert.equal(native.invokeCancel.mock.callCount(), 0);
  });

  it('signal 이 abort 되면 즉시 reject 하고 invokeCancel 을 호출한다', async () => {
    const native = makeNative([]);
    const engine = createRkyvV2Engine(native, new Map());
    const controller = new AbortController();
    const promise = engine.invoke('dynamicCmd', undefined, { signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, (e: unknown) => {
      assert.ok(e instanceof RustraCommandError);
      assert.equal((e as RustraCommandError).code, 'cancelled');
      return true;
    });
    assert.ok(native.invokeCancel.mock.callCount() >= 1);
  });

  it('cancelled 코드는 retryable 로 분류된다', () => {
    assert.ok(isRetryableCode('cancelled') === true);
  });
});
```

`isRetryableCode`는 현재 module-private이므로 export하거나 테스트에서 `RustraCommandError` 경유로 확인한다 — 후자로 (공개 API 불변 유지): `new RustraCommandError('cancelled', 'x', undefined)`의 retryable 기본값은 isRetryableCode에서 온다.

**Step 2: Run test to verify it fails**

Run: `npm run test:types 2>&1 | tail -5`
Expected: FAIL — `engine.invoke` 3번째 인자 부재, `invokeCancel` 미정의.

**Step 3: Write minimal implementation**

`packages/types/src/index.ts`:

1. `isRetryableCode`에 추가:

```typescript
function isRetryableCode(code: string): boolean {
  return code === 'transport.error' || code === 'transport.timeout' || code === 'cancelled';
}
```

2. `RustraNative`에 선택 멤버 추가 (drainEvents 뒤):

```typescript
  /** (T1) 진행 중 async 호출 취소. invokeAsync 가 반환한 invocation id 를 넘긴다. */
  invokeCancel?(invocationId: number): boolean;
```

3. `createRkyvV2Engine` 반환 객체의 `invoke` 시그니처 확장:

```typescript
export type InvokeOptions = {
  /** (T1) AbortSignal — abort 시 Promise 를 즉시 reject 하고 네이티브에 취소를 전파한다. */
  signal?: AbortSignal;
};

// invoke 내부:
invoke<T>(command: string, args?: unknown, options?: InvokeOptions): Promise<T> {
  const signal = options?.signal;
  if (signal?.aborted) {
    return Promise.reject(
      new RustraCommandError('cancelled', `invoke("${command}") aborted before dispatch`, true),
    );
  }
  // 네이티브에 invokeAsync + invokeCancel 이 있으면 취소 전파 가능한 경로 사용.
  const nativeAny = native as RkyvV2SchemaNative & {
    invokeAsync?: (payload: ArrayBuffer, cb: (resp: ArrayBuffer) => void) => number;
    invokeCancel?: (id: number) => boolean;
  };
  const canPropagate = !!nativeAny.invokeAsync && !!nativeAny.invokeCancel;

  const core = (): Promise<T> => {
    /* 기존 3-tier dispatch 로직을 그대로 함수로 추출 */
  };

  if (!signal || !canPropagate) {
    // 취소 전파 불가 — signal 리스닝만으로 JS 프라미스 거부 (얕은 취소).
    if (!signal) return core();
    return raceAbort(core(), signal, command);
  }

  return new Promise<T>((resolve, reject) => {
    let invocationId = -1;
    const onAbort = () => {
      nativeAny.invokeCancel!(invocationId);
      reject(new RustraCommandError('cancelled', `invoke("${command}") aborted`, true));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    // invokeAsync 로 진행 — 결과 도착 시 resolve 후 리스너 제거.
    ...
  });
}
```

`raceAbort` 헬퍼 (signal 감시 공통 로직):

```typescript
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal, command: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new RustraCommandError('cancelled', `invoke("${command}") aborted`, true));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
      (e) => { signal.removeEventListener('abort', onAbort); reject(e); },
    );
  });
}
```

`EngineClient.invoke` 타입(`index.ts:23-30`)도 옵션 수용하도록 확장 (선택적 3번째 파라미터 — 기존 호출자 호환).

**Step 4: Run test to verify it passes**

Run: `npm run test:types 2>&1 | tail -4`
Expected: `# fail 0`

**Step 5: Commit**

```bash
git add packages/types/src/index.ts packages/types/src/index.test.ts
git commit -m "feat(cancel): JS AbortSignal → invokeCancel 전파 + 얕은 취소 폴백 (T1)"
```

---

### Task 6: RN async 엔진 취소 전파 + 트랙 1 회귀

**Files:**
- Modify: `packages/react-native/src/index.ts:167-192` (`createAsyncEngine` invoke 옵션)
- Test: `packages/react-native/src/index.test.ts`

**Step 1: Write the failing test**

```typescript
it('createAsyncEngine: signal abort 시 reject + invokeCancel 호출 (T1)', async () => {
  const cancelMock = mock.fn();
  let capturedId = -1;
  const native = {
    ...baseNative,
    invokeTypedAsync(name: string, _args: unknown, onSuccess: Function, _onError: Function) {
      capturedId = 42; // 네이티브가 발급한 invocation id 라 가정
      // 결과는 나중에 온다 — 즉시 호출하지 않음
    },
    invokeCancel: cancelMock,
  };
  const engine = createAsyncEngine(native, { rkyvV2Codecs: new Map() });
  const controller = new AbortController();
  const p = engine.invoke('heavy', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(p, /cancelled/);
  // 폴백 정책: 네이티브 invokeCancel 이 노출된 경우 전파
  // (createAsyncEngine 은 invoke id 를 JS 에 노출하지 않는 한계 —
  //  이 태스크에선 signal 리스닝 거부만 보장, invokeCancel 전파는
  //  네이티브 invokeTypedAsync 시그니처 확장과 함께 별도 PR.)
});
```

범위 조정: RN `invokeTypedAsync` C++ 시그니처 확장(호출 id 노출)은 네이티브 재빌드가 필요해 이번 트랙 스코프를 넘는다. 이 태스크는 **얕은 취소(프라미스 거부)만** 구현하고 invokeCancel 직접 전파는 types 엔진(이미 Task 5에서 폴백 처리)에 맡긴다. 테스트도 그 수준으로.

**Step 2: Run test to verify it fails**

Run: `npm run build -w @rustra/types && npm run build -w @rustra/react-native && node --test packages/react-native/dist/index.test.js 2>&1 | tail -4`
Expected: FAIL — invoke 3번째 인자 무시됨.

**Step 3: Write minimal implementation**

`createAsyncEngine`의 invoke:

```typescript
invoke<T>(command: string, args?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const base = new Promise<T>((resolve, reject) => {
    invokeTypedAsync(command, args,
      (result) => resolve(result as T),
      (message) => reject(parseRustraErrorString(message)));
  });
  const signal = options?.signal;
  if (!signal) return base;
  if (signal.aborted) {
    return Promise.reject(new RustraCommandError('cancelled', `invoke("${command}") aborted before dispatch`, true));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RustraCommandError('cancelled', `invoke("${command}") aborted`, true));
    signal.addEventListener('abort', onAbort, { once: true });
    base.then((v) => { signal.removeEventListener('abort', onAbort); resolve(v); },
             (e) => { signal.removeEventListener('abort', onAbort); reject(e); });
  });
}
```

`RustraCommandError` import 확인 (이미 parseRustraErrorString과 함께 import됨).

**Step 4: Run test to verify it passes**

Run: `npm run test:packages 2>&1 | grep -E '^# (pass|fail)'`
Expected: pass 증가, `# fail 0`

**Step 5: 트랙 1 전체 회귀 + Commit**

```bash
cargo test -p rustra && npm run test:types && npm run test:ts:node && npm run test:packages
git add packages/react-native/src
git commit -m "feat(cancel): RN async 엔진 AbortSignal 얕은 취소 (T1 완료)"
```

---

## 트랙 2: OTA 스키마 하위 호환 (명령별 폴백)

### Task 7: Rust — command_id 미스 시 이름 라우팅 폴백

**Files:**
- Modify: `crates/rustra/src/lib.rs:723-759` (`invoke_rkyv_v2`)
- Create: `crates/rustra/tests/ota_compat_tests.rs`

**문제 재정의:** 구 JS 코드젠은 신 native의 command_id를 모른다. 하지만 JS가 보내는 것은 payload 앞 2바이트 command_id뿐이다 — 이름이 와이어에 없다. **이름 기반 폴백은 rkyv V2 바이너리 경로에서 불가능하다.** (postcard/JSON envelope 경로는 이미 이름 기반이라 문제 없음.)

**재설계된 접근:** 폴백의 방향을 뒤집는다 — **네이티브가 구 command_id도 수용**한다. `PackageBuilder`에 `alias_command_id(명령 이름, 구 ID)` 등록 API를 추가하고, `invoke_rkyv_v2`의 id 조회에서 1차 실패 시 alias 테이블을 조회한다. OTA를 배포하는 쪽(신 native)이 코드젠 시 구 스키마를 함께 받아 alias를 등록하므로, 구 JS는 구 ID 그대로 호출하고 신 native가 수용한다. 이게 실제로 가능한 유일한 방향이다 (와이어에 이름이 없으므로).

**Step 1: Write the failing test**

`crates/rustra/tests/ota_compat_tests.rs`:

```rust
//! 트랙 2 — OTA 하위 호환: 구 command_id alias 수용.

use rustra::Package;

#[path = "../benches/common.rs"]
mod common;

#[test]
fn legacy_command_id_still_dispatches_after_schema_growth() {
    // v1: add 하나 (command_id=1). 구 JS 코드젠은 add=1 로 인코딩한다.
    // v2: 앞에 새 명령 ping 이 삽입돼 add=2 가 되었지만, alias 로 1 도 수용.
    let pkg = Package::builder("ota.test")
        .command("ping", |_input: common::GreetInput| common::GreetOutput { message: "pong".into() })
        .alias_command_id("add", 1) // 구 클라이언트 호환
        .command("add", common::add)
        .build();

    // 구 클라이언트가 보낸 postcard 페이로드: cmd_id=1 + AddInput{a:2,b:3}
    let legacy_payload = {
        let mut buf = vec![1, 0]; // u16 LE cmd_id=1
        buf.extend_from_slice(&postcard::to_allocvec(&common::AddInput { a: 2, b: 3 }).unwrap());
        buf
    };

    let resp = pkg.invoke_rkyv_v2(&legacy_payload).expect("legacy id must dispatch");
    // Tier1 응답: ok=1 @0, value @8
    assert_eq!(resp[0], 1);
    let value = postcard::from_bytes::<common::AddOutput>(&resp[8..]).unwrap();
    assert_eq!(value.value, 5);
}

#[test]
fn alias_conflict_with_live_id_is_rejected_at_build() {
    // alias 가 다른 명령의 실제 command_id 와 충돌하면 빌드 시 패닉/에러.
    let result = std::panic::catch_unwind(|| {
        Package::builder("ota.conflict")
            .command("add", common::add)
            .alias_command_id("nonexistent", 1)
            .build()
    });
    assert!(result.is_err(), "alias to unknown command must fail loudly");
}
```

주의: `alias_command_id` 빌더 체인에서 "존재하지 않는 명령"은 빌드 시점(그 명령 등록 전)엔 알 수 없다 — 그래서 `build()` 시점에 검증한다. 충돌(같은 ID에 두 명령)도 `build()`에서 검증.

**Step 2: Run test to verify it fails**

Run: `cargo test -p rustra --test ota_compat_tests 2>&1 | tail -3`
Expected: FAIL — `alias_command_id` 미정의.

**Step 3: Write minimal implementation**

`crates/rustra/src/lib.rs`:

1. `RegistryState`(lib.rs:384-397 근처)에 `id_aliases: BTreeMap<u16, String>` 추가.
2. `PackageBuilder`에:

```rust
    /// (T2, OTA) 구 클라이언트의 command_id 를 현재 명령에 alias 로 수용한다.
    ///
    /// OTA 로 JS 만 갱신되는 상황의 역방향 — **구 JS + 신 네이티브** 조합에서
    /// 구 코드젠이 인코딩한 command_id 로도 명령이 도달하도록 한다.
    /// `build()` 시점에 (a) 대상 명령 존재, (b) 실제 command_id 와의 충돌
    /// 없음을 검증한다. 위반 시 패닉 (설계 오류는 조기·명시적으로).
    pub fn alias_command_id(mut self, command: &str, legacy_id: u16) -> Self {
        self.id_aliases.push((command.to_string(), legacy_id));
        self
    }
```

3. `build()` 검증 + `id_aliases` → `id_to_name` 병합 (실제 command_id 우선, alias는 역방향 조회 맵에 추가 — 충돌 시 panic).
4. `invoke_rkyv_v2`의 조회부(lib.rs:728-738)는 이미 `id_to_name`을 조회하므로, alias 병합으로 자동 해결된다 — 추가 변경 불필요.

**Step 4: Run test to verify it passes**

Run: `cargo test -p rustra --test ota_compat_tests 2>&1 | tail -3`
Expected: PASS

**Step 5: Commit**

```bash
git add crates/rustra/src/lib.rs crates/rustra/tests/ota_compat_tests.rs
git commit -m "feat(ota): alias_command_id — 구 command_id 로 신 네이티브 수용 (T2)"
```

---

### Task 8: Rust — schemaVersion 필드 + contract.stale 이벤트

**Files:**
- Modify: `crates/rustra/src/lib.rs:960-966` (`schema()` json 맨 위 `schemaVersion` 추가)
- Modify: `crates/rustra/src/lib.rs` `GeneratedPackage`/`write_to_dir` (contract.ts에 SCHEMA_VERSION)
- Test: `crates/rustra/tests/ota_compat_tests.rs` (확장)

**Step 1: Write the failing test**

```rust
#[test]
fn live_schema_carries_schema_version() {
    let pkg = Package::builder("ota.ver").command("add", common::add).build();
    let schema = pkg.live_schema();
    assert!(schema.get("schemaVersion").is_some(), "schemaVersion must be present");
}

#[test]
fn generated_contract_ts_includes_schema_version() {
    let pkg = Package::builder("ota.ver2").command("add", common::add).build();
    let generated = pkg.generate_typescript().unwrap();
    assert!(generated.contract_ts_content().contains("SCHEMA_VERSION"));
}
```

`contract_ts_content` 헬퍼가 없으므로 `write_to_dir` 후 파일 읽기로 검증하거나 `GeneratedPackage`에 `contract_ts: String` 필드를 추가한다 — 후자가 깔끔하다 (`contract_hash` 옆에).

**Step 2: Run test to verify it fails**

Run: `cargo test -p rustra --test ota_compat_tests 2>&1 | tail -3`
Expected: FAIL.

**Step 3: Write minimal implementation**

- `schema()`의 json! 매크트 출력에 `"schemaVersion": <pkg 스키마 버전>` 추가. 버전 소스: `Package`에 `schema_version: u32` 필드 + 빌더 세터(`schema_version(n)`, 기본 1). **schema.json 에 필드가 추가되면 contract_hash가 변한다** — generated/ 재생성 필수 (cargo run 예제 + CLI).
- `GeneratedPackage`에 `contract_ts: String` 필드 추가, `write_to_dir`이 그것을 쓰도록. 내용:

```rust
format!(
    "export const GENERATED_CONTRACT_HASH = '{}';\nexport const SCHEMA_VERSION = {};\n",
    self.contract_hash, self.schema_version
)
```

- CLI `generateContractTs`(packages/cli/src/generate.ts:94)도 동일하게 SCHEMA_VERSION 라인 추가 (schema.json에서 읽은 값).

**Step 4: Run test to verify it passes**

Run: `cargo test -p rustra --test ota_compat_tests 2>&1 | tail -3`
Expected: PASS

**Step 5: Regenerate + Commit**

```bash
cargo run -p rustra-calculator-example  # generated/ 재생성 (contract.ts hash 변화)
git add crates/rustra/src/lib.rs crates/rustra/tests/ota_compat_tests.rs examples/calculator/generated crates/generated packages/cli/src/generate.ts
git commit -m "feat(ota): schemaVersion 협상 필드 + SCHEMA_VERSION 코드젠 (T2)"
```

주의: `crates/generated/`가 이 커밋에 포함되는지는 그 파일들이 여전히 추적되는지에 따라 — `git status`로 확인 후 포함.

---

### Task 9: JS — onContractMismatch 옵트인 폴백 + stale 감지

**Files:**
- Modify: `packages/types/src/index.ts:431-466` (`RkyvV2EngineOptions`, mismatch 처리)
- Test: `packages/types/src/index.test.ts`

**Step 1: Write the failing test**

```typescript
describe('OTA onContractMismatch (T2)', () => {
  it('폴백 미설정 시 기존처럼 throw (하위 호환)', () => {
    const native = { invokeRkyvV2: () => new ArrayBuffer(0), getContractHash: () => encodeText('deadbeef') };
    assert.throws(
      () => createRkyvV2Engine(native, new Map(), { contractHash: 'cafebabe' }),
      /contract.mismatch/,
    );
  });

  it('폴백 설정 시 throw 대신 경고 이벤트로 강등', () => {
    const events: string[] = [];
    const native = {
      invokeRkyvV2: () => new ArrayBuffer(0),
      getContractHash: () => encodeText('deadbeef'),
    };
    const onMismatch = mock.fn();
    const engine = createRkyvV2Engine(native, new Map(), {
      contractHash: 'cafebabe',
      onContractMismatch: onMismatch,
    });
    assert.ok(onMismatch.mock.callCount() === 1);
    assert.ok(engine, 'engine is still created in degraded mode');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npm run test:types 2>&1 | tail -4`
Expected: FAIL — `onContractMismatch` 미존재.

**Step 3: Write minimal implementation**

```typescript
export type RkyvV2EngineOptions = {
  contractHash?: string;
  /**
   * (T2, OTA) 계약 해시 불일치 시의 정책. 미설정 시 기존대로 throw
   * (fail-fast). 콜백을 설정하면 엔진을 degraded 모드로 생성하고,
   * 콜백이 live schema 정보를 받아 공통 명령만 노출하는 등의
   * 복구 전략을 수행할 수 있다.
   */
  onContractMismatch?: (info: { nativeHash: string; expectedHash: string }) => void;
};
```

mismatch 블록에서: `onContractMismatch`가 있으면 호출 후 엔진 생성 계속, 없으면 기존 throw.

**Step 4: Run test to verify it passes**

Run: `npm run test:types 2>&1 | tail -3`
Expected: `# fail 0`

**Step 5: 트랙 2 회귀 + Commit**

```bash
cargo test -p rustra && npm run test:types && npm run test:ts:node && npm run test:packages
git add packages/types/src
git commit -m "feat(ota): onContractMismatch 옵트인 폴백 (T2 완료)"
```

---

## 트랙 3: 동적 페이로드 한도

### Task 10: Rust — 동적 한도 심볼 2종 + rkyv V2 경로 검사

**Files:**
- Modify: `crates/rustra/src/ffi.rs:91` (const → AtomicUsize)
- Modify: `crates/rustra/src/ffi.rs` (rkyv V2 FFI 래퍼가 있다면 검사 추가 — 조사 결과 rkyv V2는 예제 자체 FFI로 노출되므로, `rustra_ffi_invoke`/`invoke_json`/`invoke_postcard` 3개 sync + 2개 async 위임 경로는 이미 검사 경유. 예제 계층의 중복 상수는 예제 소유이므로 이번 태스크에서 정리하지 않는다 — YAGNI, 별트랙.)
- Create: 없음 (payload_robustness.rs 확장)
- Test: `crates/rustra/tests/payload_robustness.rs`

**Step 1: Write the failing test**

`payload_robustness.rs`에 추가:

```rust
// ── (T3) 동적 페이로드 한도 ───────────────────────────────

mod t3 {
    use rustra::ffi::{rustra_ffi_free, rustra_ffi_get_max_payload, rustra_ffi_invoke_json, rustra_ffi_set_max_payload};

    fn setup() {
        // 이 모듈의 테스트들은 한 번 등록된 전역 패키지를 공유한다.
        // payload_robustness.rs 상단의 기존 setup 재사용.
        super::setup_package();
    }

    #[test]
    fn default_limit_is_one_mib_and_round_trips() {
        setup();
        assert_eq!(unsafe { rustra_ffi_get_max_payload() }, 1024 * 1024);
        unsafe { rustra_ffi_set_max_payload(4 * 1024 * 1024) };
        assert_eq!(unsafe { rustra_ffi_get_max_payload() }, 4 * 1024 * 1024);
        // 후속 테스트 오염 방지 — 원복.
        unsafe { rustra_ffi_set_max_payload(1024 * 1024) };
    }

    #[test]
    fn raised_limit_admits_previously_rejected_payload() {
        setup();
        unsafe { rustra_ffi_set_max_payload(2 * 1024 * 1024) };
        let payload = vec![b'{'; 1_500_000]; // 1.5MB — 기본 한도 초과, 신 한도 이내
        let mut out_len = 0;
        let ptr = unsafe {
            rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len)
        };
        assert!(!ptr.is_null(), "within raised limit → processed (clean error ok, abort/reject-by-limit no)");
        unsafe { rustra_ffi_free(ptr, out_len) };
        unsafe { rustra_ffi_set_max_payload(1024 * 1024) };
    }

    #[test]
    fn lowered_limit_rejects_immediately() {
        setup();
        unsafe { rustra_ffi_set_max_payload(1024) };
        let payload = vec![b'a'; 2048];
        let mut out_len = 0;
        let ptr = unsafe {
            rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len)
        };
        let resp = unsafe { std::slice::from_raw_parts(ptr, out_len) };
        let text = String::from_utf8_lossy(resp);
        assert!(text.contains("payload exceeds size limit"));
        unsafe { rustra_ffi_free(ptr, out_len) };
        unsafe { rustra_ffi_set_max_payload(1024 * 1024) };
    }
}
```

주의: 기존 파일에 전역 패키지 setup 헬퍼가 없다면 `tests` 모듈 상단에 OnceLock 기반으로 추가 (기존 테스트들이 이미 register_ffi를 쓰는 방식 확인 후 정렬).

**Step 2: Run test to verify it fails**

Run: `cargo test -p rustra --test payload_robustness 2>&1 | tail -3`
Expected: FAIL — `rustra_ffi_get_max_payload` 미정의.

**Step 3: Write minimal implementation**

`crates/rustra/src/ffi.rs`:

```rust
const DEFAULT_MAX_PAYLOAD_BYTES: usize = 1024 * 1024;
static MAX_PAYLOAD_BYTES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(DEFAULT_MAX_PAYLOAD_BYTES);

fn max_payload_bytes() -> usize {
    MAX_PAYLOAD_BYTES.load(std::sync::atomic::Ordering::Relaxed)
}

/// (T3) 페이로드 크기 한도를 동적 변경한다. 기본 1 MiB.
/// 축소/확대 모두 즉시 반영된다 (Relaxed — 크기 게이트는 어림잡기 용도).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_set_max_payload(bytes: usize) {
    MAX_PAYLOAD_BYTES.store(bytes, std::sync::atomic::Ordering::Relaxed);
}

/// (T3) 현재 페이로드 크기 한도.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_get_max_payload() -> usize {
    max_payload_bytes()
}
```

기존 검사부 2곳(invoke_json:381, invoke_postcard:416)의 `payload_len > MAX_PAYLOAD_BYTES` → `payload_len > max_payload_bytes()`.

**Step 4: Run test to verify it passes**

Run: `cargo test -p rustra --test payload_robustness 2>&1 | tail -3`
Expected: PASS (기존 테스트 포함 전부).

**Step 5: Commit**

```bash
git add crates/rustra/src/ffi.rs crates/rustra/tests/payload_robustness.rs
git commit -m "feat(payload): 동적 크기 한도 set/get + 기본 1MiB 유지 (T3)"
```

---

### Task 11: JS — maxPayloadBytes 사전 검사

**Files:**
- Modify: `packages/types/src/index.ts` (`RkyvV2EngineOptions` + invoke 코어)
- Test: `packages/types/src/index.test.ts`

**Step 1: Write the failing test**

```typescript
it('maxPayloadBytes 초과 시 네이티브 호출 없이 조기 reject (T3)', async () => {
  let calls = 0;
  const native = {
    invokeRkyvV2: () => { calls++; return okResponse(); },
    invokeCancel: () => false,
  };
  const engine = createRkyvV2Engine(native, new Map(), { maxPayloadBytes: 8 });
  await assert.rejects(
    engine.invoke('someCommand', { big: 'x'.repeat(64) }),
    /payload.*8.*bytes|exceeds/i,
  );
  assert.equal(calls, 0, 'native must not be called');
});
```

주의: maxPayloadBytes 검사는 codec encode 결과 바이트 길이 기준. codec이 없는 동적 명령은 tier3 JSON 인코딩 길이 기준. 테스트는 동적 명령 경로로.

**Step 2: Run test to verify it fails**

Run: `npm run test:types 2>&1 | tail -4`
Expected: FAIL.

**Step 3: Write minimal implementation**

```typescript
export type RkyvV2EngineOptions = {
  // ... 기존
  /**
   * (T3) 요청 페이로드 바이트 한도. 인코딩 직후 검사해 네이티브 왕복 전에
   * 조기 실패시킨다. 미설정 시 검사 없음 (네이티브 기본 1MiB 가 최종 게이트).
   */
  maxPayloadBytes?: number;
};
```

invoke 코어의 2계층(codec 경로)/3계층(tier3) 인코딩 직후:

```typescript
const encoded = codec.encode(args);
if (options?.maxPayloadBytes !== undefined && encoded.byteLength > options.maxPayloadBytes) {
  return Promise.reject(new RustraCommandError(
    'payload.too_large',
    `encoded payload ${encoded.byteLength}B exceeds maxPayloadBytes ${options.maxPayloadBytes}B`,
    false,
  ));
}
```

tier3 경로도 `encodeTier3Request` 결과에 동일 검사.

**Step 4: Run test to verify it passes**

Run: `npm run test:types 2>&1 | tail -3`
Expected: `# fail 0`

**Step 5: 트랙 3 회귀 + Commit**

```bash
cargo test -p rustra && npm run test:types && npm run test:ts:node && npm run test:packages
git add packages/types/src
git commit -m "feat(payload): JS 사전 크기 검사 maxPayloadBytes (T3 완료)"
```

---

## 트랙 4: 크로스 플랫폼 CI 매트릭스

### Task 12: ci.yml rust 잡 3-OS 매트릭스 + 아티팩트

**Files:**
- Modify: `.github/workflows/ci.yml:9-28`

**Step 1: 수정**

```yaml
jobs:
  rust:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.95.0
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - name: Install system dependencies (Linux only)
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libsoup-3.0-dev libjavascriptcoregtk-4.1-dev
      - name: Check formatting
        if: matrix.os == 'ubuntu-latest'
        run: cargo fmt --all -- --check
      - name: Clippy
        if: matrix.os == 'ubuntu-latest'
        run: cargo clippy --all-targets -- -D warnings
      - name: Test
        shell: bash
        run: cargo test --workspace --exclude rustra-lynx-tauri-spike
      - name: Build release cdylib (cross-platform artifact)
        shell: bash
        run: cargo build -p rustra-calculator-example --release
      - name: Upload native artifact
        uses: actions/upload-artifact@v4
        with:
          name: rustra-native-${{ matrix.os }}
          path: |
            target/release/librustra_calculator_example.so
            target/release/librustra_calculator_example.dylib
            target/release/rustra_calculator_example.dll
          if-no-files-found: ignore
```

포인트:
- fmt/clippy는 ubuntu에서만 (중복 실행 비용 절감, 코드는 OS 무관 동일).
- macOS 크레이트 `rustra-lynx-tauri-spike` 제외는 유지 — Linux/Windows에서도 빌드 안 되므로.
- `tauri-calculator`가 default-members에 없다면 workspace test에 포함 안 됨 — 확인 후 필요시 exclude 추가. (조사: default-members가 이미 제외하고 있음 — 그대로 두면 Linux 외 OS에선 빌드 시도조차 안 됨. OK.)
- Windows 파일명은 cdylib 이름 규칙 확인 필수: Cargo.toml `name = "rustra-calculator-example"` → `rustra_calculator_example.dll` (하이픈→언더스코어).
- `cargo test --workspace`가 Linux 외에서 tauri-calculator를 건드리는지 — `--workspace`는 default-members와 무관하게 **모든 멤버**를 포함한다 (주석에 명시됨). 그래서 macOS 전용 2크레이트(lynx-tauri-spike, tauri-calculator — tauri 빌드 스크립트가 gtk 요구)를 Linux와 동일하게... 잠깐, 현행 ubuntu에서도 `--workspace --exclude rustra-lynx-tauri-spike`만 하고 tauri-calculator는 통과 중이다. tauri-calculator는 Linux에서 gtk 설치로 빌드된다. Windows/macOS에선 gtk가 없어 실패할 수 있다 → Windows/macOS 매트릭스의 Test 스텝은 `cargo test -p rustra -p rustra-calculator-example` (핵심 크레이트만)으로 축소하는 게 안전하다. **결정:** Test 스텝을 OS별 분기:

```yaml
      - name: Test (Linux — full workspace)
        if: runner.os == 'Linux'
        run: cargo test --workspace --exclude rustra-lynx-tauri-spike
      - name: Test (macOS/Windows — core crates)
        if: runner.os != 'Linux'
        shell: bash
        run: cargo test -p rustra -p rustra-calculator-example
```

**Step 2: 검증 (로컬 가능한 부분)**

Run: `cargo test -p rustra -p rustra-calculator-example 2>&1 | grep -E 'test result' | tail -5`
Expected: 전부 ok (매트릭스의 non-Linux 스텝과 동일한 명령).

`.github/workflows/ci.yml` YAML 유효성: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml'))"` 또는 `npx yaml-lint` 없으면 actionlint가 있다면 사용. 최소한 들여쓰기 육안 확인.

**Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: rust 잡 3-OS 매트릭스 + 네이티브 아티팩트 업로드 (T4)"
```

실제 검증은 push 후 GitHub Actions 실행으로만 가능 — 로컬에서 `act`가 없다면 push 후 잡 상태를 확인하는 단계를 사용자에게 안내.

---

### Task 13: 문서 업데이트 + 전체 회귀 + 마무리

**Files:**
- Modify: `docs/plans/2026-08-18-production-hardening-design.md` (완료 상태 표시 — 선택)
- Modify: `README.md` (신규 API 한 줄 소개 — 취소/한도/alias) — 저장소 README 구조 확인 후 최소한으로.

**Step 1: 전체 회귀**

```bash
cargo fmt --all -- --check && cargo clippy --all-targets -- -D warnings
cargo test -p rustra
npm run test:types && npm run test:ts:node && npm run test:packages
npm run lint && npm run format:check
```

Expected: 전부 green.

**Step 2: README 업데이트**

README의 API/기능 섹션을 찾아 다음 한 줄 추가 (기존 문체 유지):

- `alias_command_id` — OTA 구 클라이언트 command_id 호환
- `rustra_ffi_invoke_cancel` / AbortSignal `signal` 옵션
- `rustra_ffi_set_max_payload` / `maxPayloadBytes`

**Step 3: 최종 커밋**

```bash
git add README.md docs/
git commit -m "docs: production hardening 4트랙 완료 — 신규 API 문서화"
git log --oneline -15
```

---

## 실행 순서 요약

| Task | 트랙 | 산출물 | 커밋 |
|---|---|---|---|
| 1 | T1 | cancel.rs 레지스트리 | feat(cancel) |
| 2 | T1 | RustraError::cancelled | feat(cancel) |
| 3 | T1 | FFI 심볼 3종 + async 확장 | feat(cancel) |
| 4 | T1 | dispatch 체크포인트 | feat(cancel) |
| 5 | T1 | JS AbortSignal | feat(cancel) |
| 6 | T1 | RN 얕은 취소 + 회귀 | feat(cancel) |
| 7 | T2 | alias_command_id | feat(ota) |
| 8 | T2 | schemaVersion | feat(ota) |
| 9 | T2 | onContractMismatch | feat(ota) |
| 10 | T3 | 동적 한도 심볼 | feat(payload) |
| 11 | T3 | JS 사전 검사 | feat(payload) |
| 12 | T4 | CI 매트릭스 | ci |
| 13 | 전체 | 문서 + 회귀 | docs |

각 태스크는 TDD(실패 테스트 → 구현 → 통과 → 커밋)를 따른다. 트랙 경계에서 전체 회귀 스위트를 실행한다.
