//! rkyv V2 sync FFI 진입점(`rustra_calculator_invoke_rkyv_v2`)의 panic guard
//! 회귀 테스트.
//!
//! 핸들러 패닉의 직접 유도는 전역 FFI 패키지 스왑이 필요해 예제 크레이트에서
//! 불가능하다 — 패닉→internal 에러 정규화 자체는 코어 통합 테스트
//! `crates/rustra/tests/rkyv_v2_panic.rs` 가 담보한다. 여기서는 guard 추가가
//! 정상 경로를 오염하지 않는지 확인한다: (1) 정상 왕복이 여전히 성공 프레임,
//! (2) 잘린 페이로드가 여전히 clean 한 에러 프레임(ok=0) — abort 아님.
//!
//! 응답 버퍼는 calculator `alloc_response`(magic 헤더 없음) 로 할당되므로
//! 반드시 `rustra_calculator_free_buffer` 로 해제한다.

use rustra_calculator_example::{AddNumbersInput, AddNumbersOutput, calculator_package};

unsafe extern "C" {
    fn rustra_calculator_invoke_rkyv_v2(
        payload: *const u8,
        payload_len: usize,
        out_len: *mut usize,
    ) -> *mut u8;
    fn rustra_calculator_free_buffer(ptr: *mut u8, len: usize);
}

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
    unsafe { rustra_calculator_free_buffer(ptr, out_len) };
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
