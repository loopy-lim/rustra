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
        .command("countUp", |_args: serde_json::Value| {
            PROBE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, rustra::RustraError>(serde_json::json!(
                PROBE_COUNTER.load(std::sync::atomic::Ordering::SeqCst)
            ))
        })
        .command("largeCounted", large_counted)
        .command("asyncIntoCounted", async_into_counted)
        .build()
}

/// async into 전용 픽스처 — LARGE_PROBE_COUNTER 를 sync caller-buffer 테스트와
/// 공유하면 병렬 실행 시 카운터 델타가 서로 오염된다. 전용 카운터로 격리한다.
static ASYNC_INTO_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn async_into_counted(input: LargeCountedInput) -> rustra::Result<LargeCountedOutput> {
    let count = ASYNC_INTO_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    Ok(LargeCountedOutput {
        count: count as u64,
        value: "x".repeat(input.len as usize),
    })
}

/// async into 테스트 간 상호배제 — ASYNC_INTO_COUNTER 가 공유 static 이므로
/// 병렬 실행 시 델타 판정이 오염된다 (ffi.rs WORKER_TEST_MUTEX 패턴).
static ASYNC_INTO_TEST_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// probe 1회 실행 테스트용 전역 카운터 — PACKAGE OnceLock 이 테스트 간 공유되므로
/// 카운터도 패키지에 붙여 함께 공유한다(각 테스트는 자기 측정 전후 델타로 판정).
static PROBE_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
static LARGE_PROBE_COUNTER: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct LargeCountedInput {
    len: u32,
}

#[derive(Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
struct LargeCountedOutput {
    count: u64,
    value: String,
}

fn large_counted(input: LargeCountedInput) -> rustra::Result<LargeCountedOutput> {
    let count = LARGE_PROBE_COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
    Ok(LargeCountedOutput {
        count: count as u64,
        value: "x".repeat(input.len as usize),
    })
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

#[test]
fn caller_buffer_null_out_len_is_safe() {
    let payload = [1u8, 0, 0];
    let json = unsafe {
        rustra::ffi::rustra_ffi_invoke_json_into(
            payload.as_ptr(),
            payload.len(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
        )
    };
    let rkyv = unsafe {
        rustra::ffi::rustra_ffi_invoke_rkyv_v2_into(
            payload.as_ptr(),
            payload.len(),
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
        )
    };
    assert_eq!(json, usize::MAX);
    assert_eq!(rkyv, usize::MAX);
}

// ── (성능 후속) caller-buffer FFI — 3중 복사 제거 경로 ────────

/// `rustra_ffi_invoke_json_into` size-probe → 쓰기 2단계 프로토콜 검증.
#[test]
fn caller_buffer_json_invoke_probe_then_write() {
    use rustra::ffi::rustra_ffi_invoke_json_into;

    test_package().register_ffi();
    let request = serde_json::to_vec(&serde_json::json!({
        "command": "addNumbers", "args": { "a": 20, "b": 22 }
    }))
    .expect("request encodes");

    // 1) size-probe: buf=null → 필요 크기 반환
    let mut needed: usize = 0;
    let probe = unsafe {
        rustra_ffi_invoke_json_into(
            request.as_ptr(),
            request.len(),
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    assert_eq!(probe, 0, "probe must return 0 with buf=null");
    assert!(needed > 0, "probe must report needed size");

    // 2) 정확한 크기 버퍼로 쓰기 — 응답이 caller 버퍼에 직접 기록된다
    let mut buf = vec![0u8; needed];
    let mut written: usize = 0;
    let n = unsafe {
        rustra_ffi_invoke_json_into(
            request.as_ptr(),
            request.len(),
            buf.as_mut_ptr(),
            buf.len(),
            &mut written,
        )
    };
    assert_eq!(n, needed, "write must return the written byte count");
    let resp: serde_json::Value =
        serde_json::from_slice(&buf).expect("caller buffer holds JSON response");
    assert_eq!(resp["ok"], true);
    assert_eq!(resp["result"], 42);
    // Rust 가 할당한 버퍼가 없다 — 해제할 것이 없다 (3중 복사 제거의 증명).

    // 3) 부족한 버퍼 → usize::MAX 로 재시도 신호
    let mut small = vec![0u8; needed - 1];
    let mut out2: usize = 0;
    let short = unsafe {
        rustra_ffi_invoke_json_into(
            request.as_ptr(),
            request.len(),
            small.as_mut_ptr(),
            small.len(),
            &mut out2,
        )
    };
    assert_eq!(short, usize::MAX, "insufficient buffer must signal retry");
    assert_eq!(out2, needed, "needed size must be reported on retry signal");
}

/// 패닉 핸들러도 caller-buffer 경로에서 clean 에러 프레임으로 나온다.
#[test]
fn caller_buffer_json_invoke_panics_cleanly() {
    use rustra::ffi::rustra_ffi_invoke_json_into;

    test_package().register_ffi();
    let request = serde_json::to_vec(&serde_json::json!({
        "command": "panicBoom", "args": {}
    }))
    .expect("request encodes");

    let mut needed: usize = 0;
    unsafe {
        rustra_ffi_invoke_json_into(
            request.as_ptr(),
            request.len(),
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    let mut buf = vec![0u8; needed];
    let n = unsafe {
        rustra_ffi_invoke_json_into(
            request.as_ptr(),
            request.len(),
            buf.as_mut_ptr(),
            buf.len(),
            &mut needed,
        )
    };
    assert!(n != usize::MAX, "panic must not signal buffer-retry");
    let resp: serde_json::Value = serde_json::from_slice(&buf).expect("panic yields a frame");
    assert_eq!(resp["ok"], false);
    assert!(
        resp["error"].as_str().unwrap_or_default().contains("panic"),
        "error must mention panic, got: {}",
        resp["error"]
    );
}

/// probe → write 2단계 프로토콜이 핸들러를 **1회만** 실행하는지 검증한다.
///
/// 비멱등 핸들러(카운터 증가)의 사이드 이펙트가 probe 단계와 write 단계에서
/// 각각 발생하면 정확성 결함이다 — probe 결과 캐시가 이를 방지한다.
///
/// 병렬 테스트 간섭 참고: `register_ffi` 는 OnceLock 이라 프로세스 전역 패키지를
/// 공유한다. 카운터 델타 판정은 다른 테스트가 같은 명령을 호출하지 않는 한
/// 안전하다 — countUp 은 이 테스트만 호출한다. 단 캐시 검증(2단계)은 thread_local
/// 이라 같은 스레드에서 도는 이 테스트 안에서만 유효하다.
#[test]
fn caller_buffer_probe_executes_handler_exactly_once() {
    use rustra::ffi::rustra_ffi_invoke_json_into;

    test_package().register_ffi();

    let request = serde_json::to_vec(&serde_json::json!({
        "command": "countUp", "args": {}
    }))
    .expect("request encodes");

    let before = PROBE_COUNTER.load(std::sync::atomic::Ordering::SeqCst);

    // 1) probe — 핸들러 1회 실행
    let mut needed: usize = 0;
    let probe = unsafe {
        rustra_ffi_invoke_json_into(
            request.as_ptr(),
            request.len(),
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    assert_eq!(probe, 0);
    assert_eq!(
        PROBE_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        1,
        "probe must run the handler exactly once"
    );

    // 2) 부족한 버퍼 — 캐시를 보존하고 핸들러를 재실행하지 않는다.
    let mut small = vec![0u8; needed - 1];
    let short = unsafe {
        rustra_ffi_invoke_json_into(
            request.as_ptr(),
            request.len(),
            small.as_mut_ptr(),
            small.len(),
            &mut needed,
        )
    };
    assert_eq!(short, usize::MAX);
    assert_eq!(
        PROBE_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        1,
        "short write must retain the probe response without re-running the handler"
    );

    // 3) 정확한 크기로 재시도 — 같은 캐시를 소비하고 핸들러는 여전히 1회다.
    let mut buf = vec![0u8; needed];
    let n = unsafe {
        rustra_ffi_invoke_json_into(
            request.as_ptr(),
            request.len(),
            buf.as_mut_ptr(),
            buf.len(),
            &mut needed,
        )
    };
    assert_eq!(n, needed);
    assert_eq!(
        PROBE_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        1,
        "successful write must consume the probe result without re-running the handler"
    );

    // 4) 캐시 소비 후 동일 payload 재호출(write-only)은 다시 실행된다 — probe
    // 없이 들어온 호출은 신선해야 한다.
    let mut buf2 = vec![0u8; needed + 64];
    unsafe {
        rustra_ffi_invoke_json_into(
            request.as_ptr(),
            request.len(),
            buf2.as_mut_ptr(),
            buf2.len(),
            &mut needed,
        )
    };
    assert_eq!(
        PROBE_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        2,
        "a fresh write-only call (no preceding probe) must execute the handler"
    );
}

/// 패닉 에러 메시지 포맷이 경로 전체에서 단일 형태다 — 호스트 파서가 prefix
/// 하나로 분류할 수 있어야 한다.
#[test]
fn panic_message_format_is_uniform_across_paths() {
    test_package().register_ffi();

    // alloc 경로 (with_panic_guard)
    let alloc_resp = invoke_json(
        &serde_json::to_vec(&serde_json::json!({
            "command": "panicBoom", "args": {}
        }))
        .unwrap(),
    );
    let alloc_err = alloc_resp["error"].as_str().unwrap_or_default();

    // caller-buffer 경로
    use rustra::ffi::rustra_ffi_invoke_json_into;
    let request = serde_json::to_vec(&serde_json::json!({
        "command": "panicBoom", "args": {}
    }))
    .unwrap();
    let mut needed: usize = 0;
    unsafe {
        rustra_ffi_invoke_json_into(
            request.as_ptr(),
            request.len(),
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    let mut buf = vec![0u8; needed];
    unsafe {
        rustra_ffi_invoke_json_into(
            request.as_ptr(),
            request.len(),
            buf.as_mut_ptr(),
            buf.len(),
            &mut needed,
        )
    };
    let into_resp: serde_json::Value = serde_json::from_slice(&buf).unwrap();
    let into_err = into_resp["error"].as_str().unwrap_or_default();

    assert!(
        alloc_err.starts_with("internal: panic — "),
        "alloc path panic prefix must be uniform, got: {alloc_err}"
    );
    assert!(
        into_err.starts_with("internal: panic — "),
        "caller-buffer path panic prefix must match the alloc path, got: {into_err}"
    );
}

/// rkyv V2 caller-buffer(`rustra_ffi_invoke_rkyv_v2_into`)의 probe → write
/// 프로토콜 검증 — JSON 변형과 동일한 계약(필요 크기 보고, 직접 기록, 부족 시
/// 재probe 신호, 핸들러 1회 실행).
#[test]
fn caller_buffer_rkyv_v2_probe_then_write() {
    use rustra::ffi::rustra_ffi_invoke_rkyv_v2_into;

    test_package().register_ffi();

    // countUp 을 rkyv V2 프레임으로 — tier 판정을 위해 postcard 입력이 아닌
    // Tier 3 JSON-in-binary 프레임으로 호출한다(command_id + JSON).
    // countUp 의 command_id 를 live_schema 에서 조회.
    let pkg = test_package();
    let schema = pkg.live_schema();
    let id = schema["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "countUp")
        .unwrap()["commandId"]
        .as_u64()
        .unwrap() as u16;

    let mut req: Vec<u8> = Vec::new();
    req.extend_from_slice(&id.to_le_bytes());
    req.extend_from_slice(br#"{}"#);

    // countUp 은 serde_json::Value 핸들러라 rkyv V2 typed fast path 가 postcard
    // 디코드에 실패한다 — 에러 프레임(ok=0)도 유효한 응답이므로 여기선 프로토콜
    // (probe 크기 보고/직접 기록/재probe 신호)만 검증한다. 핸들러 1회 실행은
    // JSON caller-buffer 테스트(caller_buffer_probe_executes_handler_exactly_once)가
    // 고정한다.
    let mut needed: usize = 0;
    let probe = unsafe {
        rustra_ffi_invoke_rkyv_v2_into(
            req.as_ptr(),
            req.len(),
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    assert_eq!(probe, 0, "rkyv v2 probe must return 0");
    assert!(needed >= 10, "rkyv v2 frame must have 10-byte header");

    // write — caller 버퍼에 직접 기록된다.
    let mut buf = vec![0u8; needed];
    let n = unsafe {
        rustra_ffi_invoke_rkyv_v2_into(
            req.as_ptr(),
            req.len(),
            buf.as_mut_ptr(),
            buf.len(),
            &mut needed,
        )
    };
    assert_eq!(n, needed, "write returns byte count");
    assert!(
        buf[0] == 1 || buf[0] == 0,
        "rkyv v2 ok flag byte, got {}",
        buf[0]
    );

    // 3) 부족한 버퍼 → 재probe 신호
    let mut small = vec![0u8; needed.saturating_sub(1)];
    let mut out2: usize = 0;
    let short = unsafe {
        rustra_ffi_invoke_rkyv_v2_into(
            req.as_ptr(),
            req.len(),
            small.as_mut_ptr(),
            small.len(),
            &mut out2,
        )
    };
    if needed > 0 {
        assert_eq!(short, usize::MAX, "insufficient buffer signals retry");
    }
}

/// RN JSI의 512B 스택 버퍼를 넘는 응답도 probe → short write → 정확한 write
/// 전체에서 핸들러가 1회만 실행된다. 과거 어댑터가 큰 응답에서 alloc API로
/// 폴백해 비멱등 명령을 두 번 실행하던 회귀를 코어 프로토콜 수준에서 고정한다.
#[test]
fn caller_buffer_rkyv_v2_large_response_executes_exactly_once() {
    use rustra::ffi::rustra_ffi_invoke_rkyv_v2_into;

    test_package().register_ffi();
    let schema = test_package().live_schema();
    let id = schema["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "largeCounted")
        .unwrap()["commandId"]
        .as_u64()
        .unwrap() as u16;

    let input = LargeCountedInput { len: 2048 };
    let input_bytes = postcard::to_allocvec(&input).unwrap();
    let mut request = id.to_le_bytes().to_vec();
    request.extend_from_slice(&input_bytes);
    let before = LARGE_PROBE_COUNTER.load(std::sync::atomic::Ordering::SeqCst);

    let mut needed = 0usize;
    let probe = unsafe {
        rustra_ffi_invoke_rkyv_v2_into(
            request.as_ptr(),
            request.len(),
            std::ptr::null_mut(),
            0,
            &mut needed,
        )
    };
    assert_eq!(probe, 0);
    assert!(
        needed > 512,
        "fixture must exercise the JSI large-response path"
    );
    assert_eq!(
        LARGE_PROBE_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        1
    );

    let mut small = vec![0u8; 512];
    let short = unsafe {
        rustra_ffi_invoke_rkyv_v2_into(
            request.as_ptr(),
            request.len(),
            small.as_mut_ptr(),
            small.len(),
            &mut needed,
        )
    };
    assert_eq!(short, usize::MAX);
    assert_eq!(
        LARGE_PROBE_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        1,
        "short write must not consume the cached response"
    );

    let mut response = vec![0u8; needed];
    let written = unsafe {
        rustra_ffi_invoke_rkyv_v2_into(
            request.as_ptr(),
            request.len(),
            response.as_mut_ptr(),
            response.len(),
            &mut needed,
        )
    };
    assert_eq!(written, needed);
    assert_eq!(response[0], 1);
    let output: LargeCountedOutput = postcard::from_bytes(&response[8..]).unwrap();
    assert_eq!(output.value.len(), 2048);
    assert_eq!(output.count, (before + 1) as u64);
    assert_eq!(
        LARGE_PROBE_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        1,
        "probe and final write must execute the large handler exactly once"
    );
}

// ── async caller-buffer (rkyv V2 async into, F3) ────────────
//
// 비동기 완료 콜백이 caller 버퍼에 직접 기록하는 변형의 계약 검증.
// 스레딩 모델: dispatch 와 on_complete 모두 워커 스레드에서 실행된다
// (run_worker_into). 따라서 sync _into 의 probe → write 2단계 재시도는
// 쓸 수 없다 — 재시도 호출이 다른 워커에 배정되면 thread-local probe
// 캐시가 미스나 핸들러가 재실행된다. 대신 overflow 시 Rust 가 같은
// dispatch 안에서 heap 프레임으로 폴백해 owned=1 로 전달한다 — 핸들러는
// 정확히 1회, 재시도 왕복 없음.

/// 캡처 레코드 — (frame bytes, len, owned 플래그, resp 포인터 주소).
/// 포인터 주소로 caller 버퍼 정체(caller 버퍼 vs Rust heap)를 판정한다.
type CapturedFrame = (Vec<u8>, usize, u8, usize);

/// on_complete 콜백 수신물 캡처.
struct AsyncIntoCapture {
    frame: std::sync::Mutex<Option<CapturedFrame>>,
    fired: std::sync::atomic::AtomicBool,
}

impl AsyncIntoCapture {
    fn new() -> Self {
        Self {
            frame: std::sync::Mutex::new(None),
            fired: std::sync::atomic::AtomicBool::new(false),
        }
    }

    fn wait(&self) -> CapturedFrame {
        for _ in 0..2_000 {
            if self.fired.load(std::sync::atomic::Ordering::Acquire) {
                return self
                    .frame
                    .lock()
                    .unwrap()
                    .take()
                    .expect("fired callback must carry a frame");
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        panic!("async into callback did not fire within timeout");
    }
}

unsafe extern "C" fn async_into_capture_cb(
    user: *mut std::ffi::c_void,
    resp: *mut u8,
    resp_len: usize,
    owned: u8,
) {
    let cap = unsafe { &*(user as *const AsyncIntoCapture) };
    let bytes = if resp.is_null() {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(resp, resp_len) }.to_vec()
    };
    *cap.frame.lock().unwrap() = Some((bytes, resp_len, owned, resp as usize));
    // Publish completion only after the captured frame is visible.
    cap.fired.store(true, std::sync::atomic::Ordering::Release);
}

/// owned=1 프레임을 rustra_ffi_free 로 해제까지 수행하는 콜백 — free 짝
/// (debug free_guard 가 잘못된 짝이면 abort) 을 테스트가 증명한다.
unsafe extern "C" fn async_into_capture_and_free_cb(
    user: *mut std::ffi::c_void,
    resp: *mut u8,
    resp_len: usize,
    owned: u8,
) {
    unsafe { async_into_capture_cb(user, resp, resp_len, owned) };
    if owned == 1 {
        unsafe { rustra::ffi::rustra_ffi_free(resp, resp_len) };
    }
}

fn large_counted_request(len: u32) -> Vec<u8> {
    let schema = test_package().live_schema();
    let id = schema["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "asyncIntoCounted")
        .unwrap()["commandId"]
        .as_u64()
        .unwrap() as u16;
    let mut request = id.to_le_bytes().to_vec();
    request.extend_from_slice(&postcard::to_allocvec(&LargeCountedInput { len }).unwrap());
    request
}

/// 작은 응답은 caller 버퍼에 직접 기록되고(owned=0, 포인터 동일) 핸들러는
/// 1회 실행된다. 완료 후 invocation 레지스트리도 정리된다.
#[test]
fn async_into_writes_caller_buffer_in_place() {
    use rustra::ffi::rustra_ffi_invoke_rkyv_v2_async_into;

    test_package().register_ffi();
    let request = large_counted_request(4);

    let cap = AsyncIntoCapture::new();
    let _guard = ASYNC_INTO_TEST_MUTEX
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let mut buf = vec![0u8; 512];
    let buf_addr = buf.as_ptr() as usize;
    let mut invocation_id: u64 = 0;
    let before = ASYNC_INTO_COUNTER.load(std::sync::atomic::Ordering::SeqCst);
    unsafe {
        rustra_ffi_invoke_rkyv_v2_async_into(
            request.as_ptr(),
            request.len(),
            buf.as_mut_ptr(),
            buf.len(),
            &cap as *const _ as *mut std::ffi::c_void,
            Some(async_into_capture_cb),
            &mut invocation_id,
        )
    };
    assert!(invocation_id > 0, "a fresh invocation id must be issued");

    let (bytes, len, owned, ptr_addr) = cap.wait();
    assert_eq!(
        owned, 0,
        "small response must be written into the caller buffer"
    );
    assert_eq!(
        ptr_addr, buf_addr,
        "callback must receive the caller buffer itself"
    );
    assert_eq!(len, bytes.len());
    assert_eq!(bytes[0], 1, "success frame ok flag must be 1");
    let out: LargeCountedOutput = postcard::from_bytes(&bytes[8..]).unwrap();
    assert_eq!(out.value.len(), 4);
    assert_eq!(out.count, (before + 1) as u64);
    assert_eq!(
        ASYNC_INTO_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        1,
        "the handler must execute exactly once"
    );
    assert_eq!(
        rustra::cancel::status(invocation_id),
        rustra::cancel::Status::Unknown,
        "completion must clear the registry entry"
    );
}

/// caller 버퍼가 부족하면 재시도 없이 같은 dispatch 안에서 heap 프레임으로
/// 폴백한다(owned=1). 핸들러 1회, rustra_ffi_free 짝이 성립한다.
#[test]
fn async_into_overflow_falls_back_to_owned_frame_exactly_once() {
    use rustra::ffi::rustra_ffi_invoke_rkyv_v2_async_into;

    test_package().register_ffi();
    let request = large_counted_request(2048);

    let cap = AsyncIntoCapture::new();
    let _guard = ASYNC_INTO_TEST_MUTEX
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let mut small = vec![0u8; 16];
    let small_addr = small.as_ptr() as usize;
    let mut invocation_id: u64 = 0;
    let before = ASYNC_INTO_COUNTER.load(std::sync::atomic::Ordering::SeqCst);
    unsafe {
        rustra_ffi_invoke_rkyv_v2_async_into(
            request.as_ptr(),
            request.len(),
            small.as_mut_ptr(),
            small.len(),
            &cap as *const _ as *mut std::ffi::c_void,
            Some(async_into_capture_and_free_cb),
            &mut invocation_id,
        )
    };

    let (bytes, len, owned, ptr_addr) = cap.wait();
    assert_eq!(owned, 1, "overflow must deliver an owned heap frame");
    assert_ne!(
        ptr_addr, small_addr,
        "owned frame must not alias the caller buffer"
    );
    assert_eq!(len, bytes.len());
    assert_eq!(bytes[0], 1);
    let out: LargeCountedOutput = postcard::from_bytes(&bytes[8..]).unwrap();
    assert_eq!(out.value.len(), 2048);
    assert_eq!(
        ASYNC_INTO_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        1,
        "overflow fallback must not re-run the handler"
    );
    // owned=1 해제는 콜백 안에서 끝났다 — debug free_guard 가 잘못된 짝이면
    // 여기 도달 전에 abort 된다.
    assert_eq!(
        rustra::cancel::status(invocation_id),
        rustra::cancel::Status::Unknown
    );
}

/// buf=null 이면 어떤 응답이든 owned=1 로 전달된다 — caller 버퍼 계약의
/// 성립 조건(버퍼 제공)을 명시적으로 고정한다.
#[test]
fn async_into_null_buffer_delivers_owned_frame() {
    use rustra::ffi::rustra_ffi_invoke_rkyv_v2_async_into;

    test_package().register_ffi();
    let request = large_counted_request(4);

    let cap = AsyncIntoCapture::new();
    let _guard = ASYNC_INTO_TEST_MUTEX
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let mut invocation_id: u64 = 0;
    unsafe {
        rustra_ffi_invoke_rkyv_v2_async_into(
            request.as_ptr(),
            request.len(),
            std::ptr::null_mut(),
            0,
            &cap as *const _ as *mut std::ffi::c_void,
            Some(async_into_capture_and_free_cb),
            &mut invocation_id,
        )
    };

    let (bytes, _, owned, ptr_addr) = cap.wait();
    assert_eq!(owned, 1, "null caller buffer must force owned delivery");
    assert_ne!(ptr_addr, 0);
    assert_eq!(bytes[0], 1);
}

/// dispatch 전 취소는 핸들러를 시작하지 않고 cancelled 에러 프레임을 caller
/// 버퍼로 전달한다(워커가 먼저 통과한 드문 경합은 성공 프레임 — 계약상 허용).
#[test]
fn async_into_pre_cancelled_skips_handler_and_delivers_error_frame() {
    use rustra::ffi::{rustra_ffi_invoke_cancel, rustra_ffi_invoke_rkyv_v2_async_into};

    test_package().register_ffi();
    let request = large_counted_request(4);

    let cap = AsyncIntoCapture::new();
    let _guard = ASYNC_INTO_TEST_MUTEX
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let mut buf = vec![0u8; 512];
    let mut invocation_id: u64 = 0;
    let before = ASYNC_INTO_COUNTER.load(std::sync::atomic::Ordering::SeqCst);
    unsafe {
        rustra_ffi_invoke_rkyv_v2_async_into(
            request.as_ptr(),
            request.len(),
            buf.as_mut_ptr(),
            buf.len(),
            &cap as *const _ as *mut std::ffi::c_void,
            Some(async_into_capture_and_free_cb),
            &mut invocation_id,
        );
        rustra_ffi_invoke_cancel(invocation_id);
    }

    let (bytes, _, owned, _) = cap.wait();
    if bytes[0] == 1 {
        // 드문 경합 — 워커가 cancel 보다 먼저 체크포인트를 통과. 계약상 허용.
        return;
    }
    let (code, message) = decode_error_wire_public(&bytes);
    assert_eq!(code, "cancelled");
    assert!(
        message.contains("cancelled before dispatch"),
        "message should point at the pre-dispatch checkpoint, got: {message}"
    );
    assert_eq!(owned, 0, "small error frame must fit the caller buffer");
    assert_eq!(
        ASYNC_INTO_COUNTER.load(std::sync::atomic::Ordering::SeqCst) - before,
        0,
        "pre-cancelled invocation must never start the handler"
    );
}

/// decode_error_wire 의 퍼블릭 래퍼 — calculator 테스트와 동일한 파싱.
fn decode_error_wire_public(frame: &[u8]) -> (String, String) {
    assert!(frame.len() >= 10, "error frame must carry the 10B header");
    assert_eq!(frame[0], 0, "ok flag must be 0 for an error frame");
    let body = &frame[10..];
    fn read_str(b: &[u8]) -> (String, usize) {
        let mut shift = 0;
        let mut len = 0usize;
        let mut i = 0;
        loop {
            let byte = b[i];
            len |= ((byte & 0x7f) as usize) << shift;
            i += 1;
            if byte & 0x80 == 0 {
                break;
            }
            shift += 7;
        }
        (
            String::from_utf8_lossy(&b[i..i + len]).into_owned(),
            i + len,
        )
    }
    let (code, n) = read_str(body);
    let (message, _) = read_str(&body[n..]);
    (code, message)
}

// ── schema generation FFI (dev 치환 동기화 계약, T0-2) ─────

/// `rustra_ffi_schema_generation` 이 반환하는 u64 를 읽는다.
fn invoke_schema_generation() -> u64 {
    let mut out_len: usize = 0;
    let ptr = unsafe { rustra::ffi::rustra_ffi_schema_generation(&mut out_len) };
    assert!(
        !ptr.is_null(),
        "schema_generation must return a non-null buffer"
    );
    assert_eq!(out_len, 8, "generation must be a fixed 8-byte u64 LE");
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let value = u64::from_le_bytes(bytes.try_into().unwrap());
    unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };
    value
}

/// FFI 심볼이 현재 레지스트리 세대를 u64 LE 8바이트로 반환한다. live_schema 의
/// `schemaGeneration` 필드와 같은 값을 가리킨다(TS 게이트가 소비).
///
/// 전역 FFI 컨텍스트는 idempotent(첫 register_ffi 승자 고정)라 병렬 실행 시
/// FFI가 가리키는 패키지는 이 테스트가 만든 것이 아닐 수 있다. 따라서 "내
/// register 가 FFI 세대를 올린다"는 단언은 불가능하다 — 그 진행 계약은 lib
/// 단위 테스트 `schema_generation_advances_on_register_replace_unregister` 가
/// 결정적으로 담당한다. 여기서는 **전역 선점과 무관하게 항상 참인** 계약만
/// 검증한다: 두 경로(FFI 심볼, live_schema JSON)가 같은 전역 패키지를 읽으므로
/// 세대 일치, 8바이트 LE 인코딩, 무구조 invoke 무영향은 어느 패키지가 전역이든
/// 성립한다.
#[test]
fn schema_generation_ffi_tracks_registry_mutations() {
    let g0 = invoke_schema_generation();

    // 무구조 조회는 세대를 바꾸지 않는다.
    let _ = invoke_json(br#"{"command":"echo","args":{"v":1}}"#);
    assert_eq!(
        invoke_schema_generation(),
        g0,
        "invoke must not advance generation"
    );

    // live_schema JSON의 schemaGeneration 필드와 일치 — 어느 패키지가 전역
    // FFI 컨텍스트를 소유하든 두 경로는 같은 패키지를 읽는다.
    let mut len: usize = 0;
    let ptr = unsafe { rustra::ffi::rustra_ffi_get_schema(&mut len) };
    assert!(!ptr.is_null(), "live_schema FFI must return a buffer");
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let schema: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    unsafe { rustra::ffi::rustra_ffi_free(ptr, len) };
    assert_eq!(
        schema["schemaGeneration"].as_u64(),
        Some(g0),
        "live_schema must expose the same generation the FFI returns"
    );
}

/// null out_len 가드 — get_schema 계약(F8)과 동일.
#[test]
fn schema_generation_null_out_len_returns_null() {
    let ptr = unsafe { rustra::ffi::rustra_ffi_schema_generation(std::ptr::null_mut()) };
    assert!(ptr.is_null());
}
