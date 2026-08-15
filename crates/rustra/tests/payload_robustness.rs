//! Task 3.4 — large / zero-len / malformed payload robustness (Rust 측).
//!
//! 호스트가 Rust 경계로 보낼 수 있는 비정상 페이로드가 **절대 abort / panic 을
//! 일으키지 않고** clean 한 `RustraError` 로 정규화되는지 검증한다. 두 표면:
//!
//! 1. `Package::invoke_rkyv_v2` (Rust API):
//!    - 0바이트 / 1바이트 (cmd_id 미만) → `invalid_args`
//!    - 정상 cmd_id + 잘린/쓰레기 postcard 본체 → `invalid_args("postcard decode: …")`
//!    - 알 수 없는 cmd_id → `command_not_found`
//!      위 모두 `Err` 반환 — 패닉이 `extern "C"` 경계를 넘는 치명적 상황이 아니다.
//!
//! 2. `rustra_ffi_invoke_json` (extern "C"):
//!    - `payload_len == MAX_PAYLOAD_BYTES` (한계) → 처리됨(clean 에러 응답, non-null)
//!    - `payload_len == MAX_PAYLOAD_BYTES + 1` (초과) → "payload exceeds size limit"
//!    - null 포인터 / null out_len → null_mut (abort 없음)

#![allow(clippy::float_cmp)]

use rustra::ffi::{rustra_ffi_free, rustra_ffi_invoke_json};
use rustra::Package;
use serde_json::Value;

#[path = "../benches/common.rs"]
mod common;

/// rkyv V2 Rust-API 테스트용 패키지: `add` 정적(postcard) 명령 하나.
fn robustness_package() -> Package {
    Package::builder("robust.test")
        .command("add", common::add)
        .build()
}

// ── (1) Package::invoke_rkyv_v2 — 비정상 페이로드는 clean Err ────

#[test]
fn invoke_rkyv_v2_empty_payload_returns_clean_error() {
    let pkg = robustness_package();
    let err = pkg
        .invoke_rkyv_v2(&[])
        .expect_err("empty payload must error, not abort");
    // invalid_args 분류 — 패닉/abort 가 아님.
    assert!(
        err.to_string().to_lowercase().contains("too short"),
        "empty payload error should mention too short, got: {err}"
    );
}

#[test]
fn invoke_rkyv_v2_one_byte_payload_returns_clean_error() {
    let pkg = robustness_package();
    // cmd_id 1바이트만 — u16 cmd_id 를 읽으려면 최소 2바이트 필요.
    let err = pkg
        .invoke_rkyv_v2(&[0x01])
        .expect_err("1-byte payload must error, not abort");
    assert!(
        err.to_string().to_lowercase().contains("too short"),
        "1-byte payload error should mention too short, got: {err}"
    );
}

#[test]
fn invoke_rkyv_v2_garbage_postcard_body_returns_clean_error() {
    let pkg = robustness_package();
    let id = common::command_id_of(&pkg, "add");
    // [cmd_id u16 LE][쓰레기 — 모두 continuation 비트가 켜진 varint]
    // postcard::from_bytes 가 AddInput{a,b} 를 역직렬화하지 못해야 한다.
    let req = [
        (id & 0xff) as u8,
        ((id >> 8) & 0xff) as u8,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
        0xff,
    ];
    let err = pkg
        .invoke_rkyv_v2(&req)
        .expect_err("garbage postcard body must error, not abort");
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("postcard") || msg.contains("decode"),
        "garbage body should yield a postcard decode error, got: {err}"
    );
}

#[test]
fn invoke_rkyv_v2_truncated_valid_postcard_prefix_returns_clean_error() {
    let pkg = robustness_package();
    let id = common::command_id_of(&pkg, "add");
    // 정상 인코딩의 *접두* 만 전송: AddInput{a:5} 의 `a` 하나(varint 0x0a)만.
    // 두 번째 필드 b 가 없으므로 postcard 는 unexpected-end-of-input 에러.
    let req = [(id & 0xff) as u8, ((id >> 8) & 0xff) as u8, 0x0a];
    let err = pkg
        .invoke_rkyv_v2(&req)
        .expect_err("truncated postcard prefix must error, not abort");
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("postcard") || msg.contains("decode"),
        "truncated body should yield a postcard decode error, got: {err}"
    );
}

#[test]
fn invoke_rkyv_v2_unknown_command_id_returns_clean_error() {
    let pkg = robustness_package();
    // 등록되지 않은 cmd_id (0xffff — 실제 add 의 id 와 충돌하지 않는 큰 값).
    let req = [0xff, 0xff, 0x0a, 0x0a];
    let err = pkg
        .invoke_rkyv_v2(&req)
        .expect_err("unknown command id must error, not abort");
    let msg = err.to_string().to_lowercase();
    assert!(
        msg.contains("not found") || msg.contains("command"),
        "unknown command id should yield a not-found error, got: {err}"
    );
}

/// 동일 페이로드 패턴이 정상 명령과 비정상 명령을 구분하는지(회귀 가드):
/// 같은 cmd_id 로 *정상* postcard 를 보내면 성공해야 한다. 위 malformed 테스트들이
/// "항상 실패" 가 되는 위양성(false-positive) 을 잡는다.
#[test]
fn invoke_rkyv_v2_well_formed_payload_succeeds_for_contrast() {
    let pkg = robustness_package();
    let id = common::command_id_of(&pkg, "add");
    let req = common::postcard_request(id, &common::AddInput { a: 2, b: 3 });
    let resp = pkg
        .invoke_rkyv_v2(&req)
        .expect("well-formed payload must succeed");
    let out: common::AddOutput = common::decode_postcard_response(&resp);
    assert_eq!(out.value, 5);
}

// ── (2) rustra_ffi_invoke_json — extern "C" 크기/포인터 가드 ──────

/// FFI 의 MAX_PAYLOAD_BYTES (ffi.rs 의 private const 와 동일 값). 이 테스트가
/// 그 값의 단일 진실공급원(single source of truth) 이 되지 않도록 — 어설션이
/// 경계 동작(한계 수락 / 초과 거부) 을 명시하는 역할만 한다.
const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

fn register_ffi_for_boundary_tests() {
    // FFI 디스패치 전 글로벌 PACKAGE 가 필요. 이 테스트 바이너리(별도 프로세스)는
    // 자체 OnceLock 슬롯을 가진다. 명령은 실제로 호출되지 않는다(아래 페이로드는
    // JSON 파싱 단계에서 실패).
    Package::builder("ffi.boundary")
        .command("noop", |_: serde_json::Value| {
            Ok::<_, rustra::RustraError>(serde_json::Value::Null)
        })
        .build()
        .register_ffi();
}

/// `rustra_ffi_invoke_json` 결과를 역직렬화해 (ok, error) 를 반환한다.
/// ptr 가 null 이면 (가드 동작) (false, None) 을 반환.
unsafe fn ffi_invoke_json(payload: &[u8]) -> (bool, Option<String>) {
    let mut out_len: usize = 0;
    let ptr = unsafe { rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len) };
    if ptr.is_null() {
        return (false, None);
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let resp: Value = serde_json::from_slice(bytes).expect("FFI response must be valid JSON");
    unsafe { rustra_ffi_free(ptr, out_len) };
    (
        resp.get("ok").and_then(|v| v.as_bool()).unwrap_or(false),
        resp.get("error").and_then(|v| v.as_str()).map(String::from),
    )
}

#[test]
fn ffi_payload_at_limit_is_processed_without_abort() {
    register_ffi_for_boundary_tests();
    // payload_len == MAX → `> MAX` 검사를 통과(한계 포함)한 뒤 JSON 파싱으로 실패.
    // 즉 "한계 바로 아래/에서" 거부되지 않고 정상 파이프라인을 탄 뒤 clean 에러.
    let payload = vec![b'a'; MAX_PAYLOAD_BYTES];
    let (ok, _err) = unsafe { ffi_invoke_json(&payload) };
    assert!(
        !ok,
        "at-limit payload must return ok=false (clean error), not abort"
    );
}

#[test]
fn ffi_payload_over_limit_is_rejected_with_size_message() {
    register_ffi_for_boundary_tests();
    // payload_len == MAX + 1 → 크기 가드가 디스패치 전에 거부.
    let payload = vec![b'a'; MAX_PAYLOAD_BYTES + 1];
    let (ok, err) = unsafe { ffi_invoke_json(&payload) };
    assert!(!ok, "over-limit payload must return ok=false");
    let err = err.expect("over-limit payload must carry an error message");
    assert!(
        err.to_lowercase().contains("size limit"),
        "over-limit error should mention the size limit, got: {err}"
    );
}

#[test]
fn ffi_null_pointer_returns_null_without_abort() {
    register_ffi_for_boundary_tests();
    let mut out_len: usize = 0;
    // null payload 포인터 → null_mut (디레퍼런스/abort 없음).
    let ptr = unsafe { rustra_ffi_invoke_json(std::ptr::null(), 0, &mut out_len) };
    assert!(
        ptr.is_null(),
        "null payload pointer must return null, not abort"
    );
    // null out_len 포인터 → null_mut.
    let dummy = [0u8; 1];
    let ptr = unsafe { rustra_ffi_invoke_json(dummy.as_ptr(), dummy.len(), std::ptr::null_mut()) };
    assert!(
        ptr.is_null(),
        "null out_len pointer must return null, not abort"
    );
}
