//! Trust baseline — FFI 안전성 결함을 현재 동작으로 고정 (Phase 0).
//!
//! 두 가지 종류의 테스트를 담는다:
//!
//! 1. **음수 경로 고정 (실행 가능)** — huge payload / zero-length / postcard 에러 프레임.
//!    `rustra::ffi` 의 extern "C" 엔트리를 거쳐 실제 응답을 JSON/postcard 로 파싱해
//!    현재 거동을 단언한다.
//!
//! 2. **UB/abort 결함 방어 (실행 가능)** — F1(패닉 abort catch_unwind), F2(free 가드),
//!    F8(get_schema null out_len 가드)는 Phase 1 에서 구현·수정되어 현재는 모두
//!    활성 테스트로 전환된 상태다 (과거 `#[ignore]` + TODO 패턴에서 이관).
//!
//! 모든 테스트는 같은 패키지("trust.baseline")를 `register_ffi` 한다 — `register_ffi`는
//! `OnceLock` 기반 idempotent 이므로 병렬 실행에서도 안전하다.

use rustra::Package;
use serde::{Deserialize, Serialize};

// ── test fixture package ────────────────────────────────────

fn test_package() -> Package {
    Package::builder("trust.baseline")
        .command("addNumbers", |args: serde_json::Value| {
            let a = args["a"].as_i64().unwrap_or(0);
            let b = args["b"].as_i64().unwrap_or(0);
            Ok::<_, rustra::RustraError>(serde_json::json!(a + b))
        })
        .command(
            "panicBoom",
            |_args: serde_json::Value| -> Result<serde_json::Value, rustra::RustraError> {
                panic!("boom from handler");
            },
        )
        .build()
}

// ── wire mirror structs (private FfiResponse 들을 바깥에서 파싱) ──
// postcard 는 필드 순서 기반 직렬화이므로, 동일한 필드 순서를 가진 미러 구조체로
// decode/encode 할 수 있다. (필드명은 와이어에 실리지 않는다.)

#[derive(Serialize)]
struct PostcardEnvelope<'a> {
    command: &'a str,
    args_json: &'a str,
}

#[derive(Deserialize)]
#[allow(dead_code)] // 와이어 필드 순서 일치를 위해 result_json 유지 (단언에는 미사용)
struct PostcardResponse {
    ok: bool,
    result_json: Option<String>,
    error: Option<String>,
}

// ── invoke helpers (읽고 파싱하고 해제) ─────────────────────

fn invoke_json(payload: &[u8]) -> serde_json::Value {
    let mut out_len: usize = 0;
    let ptr = unsafe {
        rustra::ffi::rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len)
    };
    assert!(!ptr.is_null(), "FFI must return a non-null buffer");
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let resp: serde_json::Value =
        serde_json::from_slice(bytes).expect("JSON response must deserialize");
    unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };
    resp
}

fn invoke_postcard(payload: &[u8]) -> PostcardResponse {
    let mut out_len: usize = 0;
    let ptr = unsafe {
        rustra::ffi::rustra_ffi_invoke_postcard(payload.as_ptr(), payload.len(), &mut out_len)
    };
    assert!(!ptr.is_null(), "FFI must return a non-null buffer");
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let resp: PostcardResponse =
        postcard::from_bytes(bytes).expect("postcard response must deserialize");
    unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };
    resp
}

/// `invoke_json` 처럼 invoke 하지만 버퍼를 해제하지 않고 원본 `(ptr, len)` 을
/// 반환한다 — F2 free-misuse 가드 테스트에서만 사용. 호출자가 직접 해제해야 한다.
fn invoke_json_raw(payload: &[u8]) -> (*mut u8, usize) {
    let mut out_len: usize = 0;
    let ptr = unsafe {
        rustra::ffi::rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len)
    };
    assert!(!ptr.is_null(), "FFI must return a non-null buffer");
    (ptr, out_len)
}

/// `rustra_ffi_contract_hash` 가 반환하는 SHA-256 hex 문자열을 읽고 해제한다.
fn invoke_contract_hash() -> String {
    let mut out_len: usize = 0;
    let ptr = unsafe { rustra::ffi::rustra_ffi_contract_hash(&mut out_len) };
    assert!(
        !ptr.is_null(),
        "contract_hash must return a non-null buffer"
    );
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let s = std::str::from_utf8(bytes)
        .expect("contract hash is UTF-8 hex")
        .to_string();
    unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };
    s
}

// ── 음수 경로 고정: huge payload (Task 0.5 Step 1) ──────────

#[test]
fn huge_payload_rejected_with_size_limit_error() {
    test_package().register_ffi();
    // 2 MiB — MAX_PAYLOAD_BYTES(1 MiB) 초과. ffi.rs size guard 가 발동해야 한다.
    let big = vec![b' '; 2 * 1024 * 1024];

    let resp = invoke_json(&big);

    assert_eq!(
        resp["ok"], false,
        "payload over MAX_PAYLOAD_BYTES must be rejected, not dispatched"
    );
    let err = resp["error"]
        .as_str()
        .expect("rejected payload must carry an error message");
    // 에러 코드 통일(완료) — 평문 "payload exceeds size limit" 대신
    // `payload.too_large: payload NB exceeds max payload LB` 형태.
    assert!(
        err.contains("payload.too_large"),
        "error must carry the payload.too_large code, got: {err}"
    );
}

// ── 음수 경로 고정: zero-length payload ─────────────────────

#[test]
fn zero_length_payload_rejected_with_json_decode_error() {
    test_package().register_ffi();
    // 비어있지 않은(non-null) 포인터에 len=0. null 체크는 통과하지만 JSON 디코딩은 실패한다.
    let empty: Vec<u8> = Vec::new();

    let resp = invoke_json(&empty);

    assert_eq!(
        resp["ok"], false,
        "zero-length payload must be rejected, not dispatched"
    );
    let err = resp["error"]
        .as_str()
        .expect("rejected payload must carry an error message");
    assert!(
        err.contains("json decode failed"),
        "error must mention json decode failure, got: {err}"
    );
}

// ── 음수 경로 고정: postcard 에러 프레임 (Task 0.5 Step 2) ──

#[test]
fn postcard_unknown_command_returns_error_frame() {
    test_package().register_ffi();
    let env = PostcardEnvelope {
        command: "nonexistent",
        args_json: "{}",
    };
    let payload = postcard::to_allocvec(&env).expect("envelope encodes");

    let resp = invoke_postcard(&payload);

    assert!(
        !resp.ok,
        "unknown command must yield an error frame, not ok"
    );
    let err = resp
        .error
        .expect("postcard error frame must carry an error string");
    assert!(
        err.contains("not found"),
        "postcard error frame must mention not found, got: {err}"
    );
}

// ── UB/abort 결함 가시화 (Task 0.4 — Phase 1 에서 활성화) ────

#[test]
fn panic_in_handler_returns_clean_error_not_abort() {
    test_package().register_ffi();
    // panicBoom 핸들러는 의도적으로 panic!("boom from handler") 을 일으킨다.
    // catch_unwind 가 없다면 이 패닉은 extern "C" 경계를 넘어 — 정의되지 않은 동작이거나
    // (panic=abort profile 이면) 테스트 프로세스 자체를 abort 시킨다. 이 테스트가 정상적으로
    // 끝나 응답을 단언한다는 것 자체가 "abort 되지 않았다"는 증명이다.
    let request = serde_json::json!({ "command": "panicBoom", "args": {} });
    let payload = serde_json::to_vec(&request).expect("request encodes");

    let resp = invoke_json(&payload);

    assert_eq!(
        resp["ok"], false,
        "handler panic must surface as a clean error response, not abort the process"
    );
    let err = resp["error"]
        .as_str()
        .expect("panic error must carry a message");
    assert!(
        err.contains("panic"),
        "error must identify a panic, got: {err}"
    );
    assert!(
        err.contains("boom from handler"),
        "error must carry the panic payload message, got: {err}"
    );
}

#[test]
fn free_guard_permits_exact_correct_free() {
    // F2 (regression): debug 가드가 활성화된 상태에서도 *올바른* (ptr,len) 해제는
    // 정상적으로 동작한다 (abort 없이 테스트가 완료된다 = 증거).
    //
    // 잘못된 len / double-free 를 가드가 탐지하는지(Verdict: WrongLen / NotLive)는
    // ffi.rs::free_guard 의 단위 테스트로 증명한다 — misuse 시 rustra_ffi_free 가
    // extern "C" nounwind 경계에서 abort 하므로 통합 테스트에서는 잡을 수 없다.
    test_package().register_ffi();
    let (ptr, len) = invoke_json_raw(br#"{"command":"addNumbers","args":{"a":1,"b":2}}"#);

    // 올바른 해제 → 가드가 Verdict::Sound 로 분류하고 Box::from_raw 가 정상 수행.
    // (이 호출이 돌아오면 가드가 정상 경로를 차단하지 않음이 증명된다.)
    unsafe { rustra::ffi::rustra_ffi_free(ptr, len) };
}

#[test]
fn contract_hash_is_stable_64_hex() {
    // F5 (native 측): rustra_ffi_contract_hash 가 등록된 스키마의 SHA-256 hex 를
    // 안정적으로 반환한다. TS 엔진의 contractHash 옵션 검증(TS 단위 테스트)과 짝.
    test_package().register_ffi();
    let hash1 = invoke_contract_hash();
    let hash2 = invoke_contract_hash();

    assert_eq!(
        hash1.len(),
        64,
        "SHA-256 hex must be 64 chars, got: {hash1}"
    );
    assert!(
        hash1.chars().all(|c| c.is_ascii_hexdigit()),
        "contract hash must be hex, got: {hash1}"
    );
    assert_eq!(
        hash1, hash2,
        "contract hash must be deterministic for a fixed schema"
    );
}

#[test]
fn contract_hash_null_out_len_returns_null() {
    // F5 companion: out_len=null → null ptr (F8 스타일 null 가드가 신설 함수에도 적용됨).
    let ptr = unsafe { rustra::ffi::rustra_ffi_contract_hash(std::ptr::null_mut()) };
    assert!(ptr.is_null(), "null out_len must yield null ptr, not UB");
}

#[test]
fn get_schema_with_null_out_len_is_safe() {
    // F8: out_len=null 로 rustra_ffi_get_schema 호출 시 null ptr 를 반환한다 (UB/abort 아님).
    // 예전엔 alloc_response 가 *out_len 에 write 해 null deref → UB 였다.
    test_package().register_ffi();
    let ptr = unsafe { rustra::ffi::rustra_ffi_get_schema(std::ptr::null_mut()) };
    assert!(
        ptr.is_null(),
        "null out_len must yield a null ptr, not dereference it"
    );
}
