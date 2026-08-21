//! rkyv V2 sync/async FFI 진입점의 panic guard 회귀 테스트.
//!
//! 핸들러 패닉의 직접 유도는 전역 FFI 패키지 스왑이 필요해 예제 크레이트에서
//! 불가능하다 — 패닉→internal 에러 정규화 자체는 코어 통합 테스트
//! `crates/rustra/tests/rkyv_v2_panic.rs` 가 담보한다. 여기서는 guard 추가가
//! 정상 경로를 오염하지 않는지 확인한다: (1) 정상 왕복이 여전히 성공 프레임,
//! (2) 잘린 페이로드가 여전히 clean 한 에러 프레임(ok=0) — abort 아님.
//!
//! async 진입점(`rustra_calculator_invoke_rkyv_v2_async`)은 on-complete 계약을
//! 핀한다: 워커가 어떤 경로로 끝나도 (1) `on_complete` 가 정확히 1회 발화
//! (JS 프라미스 hang 방지), (2) 취소 레지스트리 엔트리가 정리됨(Unknown).
//! 패닉 유도가 불가능하므로 정상 경로 계약 고정이 곧 구조 보장의 기준선이다.
//!
//! 응답 버퍼는 (rkyv V2 sync 경로가 코어 `rustra_ffi_invoke_rkyv_v2` 로 위임된
//! 이후) 코어 FFI 할당 레이아웃을 따른다 — 반드시
//! `rustra_calculator_free_rkyv_v2_buffer`(코어 `rustra_ffi_free` 위임)로
//! 해제한다. async 경로는 여전히 calculator 자체 `alloc_response` 레이아웃이므로
//! `rustra_calculator_free_buffer` 를 쓴다.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use rustra_calculator_example::{AddNumbersInput, AddNumbersOutput, calculator_package};

unsafe extern "C" {
    fn rustra_calculator_invoke_rkyv_v2(
        payload: *const u8,
        payload_len: usize,
        out_len: *mut usize,
    ) -> *mut u8;
    fn rustra_calculator_free_rkyv_v2_buffer(ptr: *mut u8, len: usize);
    fn rustra_calculator_free_buffer(ptr: *mut u8, len: usize);
    fn rustra_calculator_invoke_rkyv_v2_async(
        payload: *const u8,
        payload_len: usize,
        user_data: *mut c_void,
        on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
        invocation_id: *mut u64,
    );
}

// ── async on-complete 계약 관측용 전역 (테스트 간 공유하지 않는다) ──────
static ASYNC_DONE: AtomicBool = AtomicBool::new(false);
static ASYNC_OK: AtomicBool = AtomicBool::new(false);
static ASYNC_FIRED: AtomicUsize = AtomicUsize::new(0);

/// addNumbers 의 cmd_id — calculator `register!` 등록순 첫 명령(하드코딩 회피:
/// live_schema 에서 조회한다).
fn add_numbers_id() -> u16 {
    let pkg = calculator_package();
    let schema = pkg.live_schema();
    schema["commands"]
        .as_array()
        .expect("live schema must list commands")
        .iter()
        .find(|c| c["name"] == "addNumbers")
        .expect("addNumbers must be registered")["commandId"]
        .as_u64()
        .expect("commandId must be a number") as u16
}

/// FFI 진입 → 응답 바이트. 패닉 가드가 없으면 abort/handle 되지 않은 패닉으로
/// 테스트 프로세스가 죽는다 — 정상 복귀 자체가 계약의 일부다.
fn invoke_rkyv_v2(payload: &[u8]) -> Vec<u8> {
    let mut out_len = 0usize;
    let ptr =
        unsafe { rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len) };
    assert!(
        !ptr.is_null(),
        "FFI must return a response buffer, not null"
    );
    let out = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
    unsafe { rustra_calculator_free_rkyv_v2_buffer(ptr, out_len) };
    out
}

#[test]
fn normal_roundtrip_still_works() {
    let mut req = add_numbers_id().to_le_bytes().to_vec();
    req.extend_from_slice(
        &postcard::to_allocvec(&AddNumbersInput { a: 42, b: 58 }).expect("postcard encode"),
    );
    let resp = invoke_rkyv_v2(&req);
    // 성공 프레임: [ok=1 @0][7B reserved][postcard(AddNumbersOutput) @8]
    assert_eq!(resp.first(), Some(&1), "ok flag");
    let out: AddNumbersOutput = postcard::from_bytes(&resp[8..]).expect("postcard decode response");
    assert_eq!(out.value, 100);
}

#[test]
fn truncated_payload_is_clean_error_frame() {
    // cmd_id 만 있고 본문 없음 — postcard 디코드가 clean 하게 실패해야 한다.
    let resp = invoke_rkyv_v2(&add_numbers_id().to_le_bytes());
    assert_eq!(
        resp.first(),
        Some(&0),
        "error flag — truncated payload must be a clean error frame, not abort"
    );
}

// ── async: on-complete 1회 + 레지스트리 정리 계약 ─────────────────────

unsafe extern "C" fn async_test_cb(_ud: *mut c_void, resp: *mut u8, len: usize) {
    ASYNC_FIRED.fetch_add(1, Ordering::SeqCst);
    if !resp.is_null() && len > 0 {
        let first = unsafe { *resp }; // ok flag
        ASYNC_OK.store(first == 1, Ordering::SeqCst);
        unsafe { rustra_calculator_free_buffer(resp, len) };
    }
    ASYNC_DONE.store(true, Ordering::SeqCst);
}

/// 정상 async 호출의 완결 계약: (1) on_complete 가 반드시 1회 발화 (JS 프라미스
/// hang 방지 — 발화 안 되면 이 테스트의 5s 데드라인에서 실패), (2) 성공 프레임,
/// (3) 완료 후 취소 레지스트리가 Unknown 으로 정리 (엔트리 누수 방지).
/// 패닉 경로 유도는 불가능하므로 red-first 가 아니라 계약 고정(contract pin)
/// 테스트다 — Drop guard 구조 보장의 기준선이 된다.
#[test]
fn async_invoke_completes_exactly_once_and_cleans_registry() {
    let mut req = add_numbers_id().to_le_bytes().to_vec();
    req.extend_from_slice(
        &postcard::to_allocvec(&AddNumbersInput { a: 7, b: 35 }).expect("postcard encode"),
    );

    let mut id: u64 = 0;
    unsafe {
        rustra_calculator_invoke_rkyv_v2_async(
            req.as_ptr(),
            req.len(),
            std::ptr::null_mut(),
            Some(async_test_cb),
            &mut id,
        );
    }
    assert!(id != 0, "async invoke must issue a non-zero invocation id");

    // on_complete 발화 대기 — 5s 데드라인. 발화하지 않으면 JS 프라미스가
    // 영구히 hang 한다(구조 보장이 없는 현 결함의 증상).
    let deadline = Instant::now() + Duration::from_secs(5);
    while !ASYNC_DONE.load(Ordering::SeqCst) {
        assert!(
            Instant::now() < deadline,
            "on_complete never fired — JS promise would hang"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert!(ASYNC_OK.load(Ordering::SeqCst), "normal call must succeed");

    // 정확히 1회 — 완료 후 짧은 여유로 중복 발화 여부를 잡는다.
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        ASYNC_FIRED.load(Ordering::SeqCst),
        1,
        "on_complete must fire exactly once"
    );

    // 레지스트리 정리 — 완료(complete_invocation)는 엔트리를 제거하므로
    // Unknown 이 terminal 상태다. complete→callback 순서 계약상 이미
    // Unknown 이어야 하지만 경합 여유로 짧게 폴링한다.
    let deadline = Instant::now() + Duration::from_secs(1);
    while rustra::cancel::status(id) != rustra::cancel::Status::Unknown {
        assert!(
            Instant::now() < deadline,
            "registry entry leaked — complete_invocation never ran"
        );
        thread::sleep(Duration::from_millis(5));
    }
}
