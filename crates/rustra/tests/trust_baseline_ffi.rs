//! Trust baseline — FFI 안전성 결함을 현재 동작으로 고정 (Phase 0).
//!
//! 두 가지 종류의 테스트를 담는다:
//!
//! 1. **음수 경로 고정 (실행 가능)** — huge payload / zero-length / postcard 에러 프레임.
//!    `rustra::ffi` 의 extern "C" 엔트리를 거쳐 실제 응답을 JSON/postcard 로 파싱해
//!    현재 거동을 단언한다. Phase 1에서 결함을 수정하면 일부 단언이 전환된다.
//!
//! 2. **UB/abort 결함 가시화 (`#[ignore]`)** — F1(패닉 abort), F2(double-free/wrong-len UB),
//!    F8(get_schema null out_len deref UB)는 실행 시 프로세스를 죽이므로 일반 `#[test]`로
//!    잡을 수 없다. 명시적 `#[ignore]` + TODO 본문으로 "알고 있는 깨진 것"으로 표시하고,
//!    Phase 1에서 구현과 동시에 본문을 채운 뒤 ignore를 제거한다.
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

// ── 음수 경로 고정: huge payload (Task 0.5 Step 1) ──────────

#[test]
fn huge_payload_rejected_with_size_limit_error() {
    test_package().register_ffi();
    // 2 MiB — MAX_PAYLOAD_BYTES(1 MiB) 초과. ffi.rs:203 size guard 가 발동해야 한다.
    let big = vec![b' '; 2 * 1024 * 1024];

    let resp = invoke_json(&big);

    assert_eq!(
        resp["ok"], false,
        "payload over MAX_PAYLOAD_BYTES must be rejected, not dispatched"
    );
    let err = resp["error"]
        .as_str()
        .expect("rejected payload must carry an error message");
    assert!(
        err.contains("size limit"),
        "error must mention the size limit, got: {err}"
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
#[ignore = "F1: catch_unwind 미구현 — 핸들러 패닉 시 호스트 프로세스 abort. \
            Phase 1 (Task 1.1) 에서 catch_unwind 추가 후 본문 채우고 ignore 제거"]
fn panic_in_handler_returns_clean_error_not_abort() {
    // TODO Phase 1 (Task 1.1): 패닉을 일으키는 핸들러("panicBoom")를 등록하고 invoke →
    //   - 응답이 ok:false + clean error(panic 원인 포함) 이고
    //   - 프로세스가 abort 되지 않음(별도 프로세스 증명 포함)
    //   을 단언. 현재는 패닉이 extern "C" 경계를 넘어 호스트를 죽인다.
}

#[test]
#[ignore = "F2: rustra_ffi_free 가 double-free/wrong-len 을 막지 못함 → UB. \
            Phase 1 (Task 1.4) 에서 debug_assert 가드 추가 후 본문 채우고 ignore 제거"]
fn free_wrong_len_is_detected() {
    // TODO Phase 1 (Task 1.4): 잘못된 len 으로 rustra_ffi_free 호출 시
    //   가드가 탐지(panic on debug / 안전 무시 on release) 함을 단언.
    //   현재는 잘못된 len → Box::from_raw size 불일치 → UB.
}

#[test]
#[ignore = "F8: rustra_ffi_get_schema 가 out_len null 체크 누락 → null deref UB. \
            Phase 1 (Task 1.6) 에서 null 체크 추가 후 본문 채우고 ignore 제거"]
fn get_schema_with_null_out_len_is_safe() {
    // TODO Phase 1 (Task 1.6): out_len=null 로 rustra_ffi_get_schema 호출 시
    //   null ptr 반환(abort 아님) 단언. 현재는 alloc_response 가 *out_len 에 write → UB.
}
