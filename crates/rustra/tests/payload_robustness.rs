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
//!
//! 3. (T3) 동적 페이로드 한도 — `rustra_ffi_set/get_max_payload`:
//!    - 기본값 1 MiB pin + set/get round-trip
//!    - 상향 → 기존에 거부되던 크기가 승인 (한도 에러 아닌 정상 파이프라인)
//!    - 하향(1024) → `payload.too_large` 로 거부 (코드 통일, T3 후속)
//!    - 한도 변경 테스트는 전부 [`LIMIT_MUTEX`] 로 직렬화 + guard drop 에서
//!      1 MiB 원복 — 위 (2) 의 1 MiB 가정 테스트와의 병렬 경합을 없앤다.
//!
//! 4. (T3 후속) rkyv V2 경로 크기 게이트 — `Package::invoke_rkyv_v2`:
//!    - over-limit → `payload.too_large` 코드 + 바이트 컨텍스트
//!    - 한도 하향이 V2 경로에도 즉시 반영
//!    - ==limit → 게이트 통과 (정상 파이프라인에서 실패)

#![allow(clippy::float_cmp)]

use rustra::Package;
use rustra::ffi::{
    rustra_ffi_free, rustra_ffi_get_max_payload, rustra_ffi_invoke_json, rustra_ffi_set_max_payload,
};
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

/// FFI 페이로드 한도의 기본값 (ffi.rs 의 `DEFAULT_MAX_PAYLOAD_BYTES` 와 동일 값).
/// 이 테스트가 그 값의 단일 진실공급원(single source of truth) 이 되지 않도록 —
/// 어설션이 경계 동작(한계 수락 / 초과 거부) 을 명시하는 역할만 한다. 런타임
/// 한도는 이제 동적(T3) 이지만, 아래 두 테스트는 기본값 상태에서만 돈다.
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
    // 한도 기본값(1 MiB) 을 가정하는 테스트 — (T3) 한도 변경 테스트와 상호배제.
    let _guard = limit_guard();
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
    // 한도 기본값(1 MiB) 을 가정하는 테스트 — (T3) 한도 변경 테스트와 상호배제.
    let _guard = limit_guard();
    register_ffi_for_boundary_tests();
    // payload_len == MAX + 1 → 크기 가드가 디스패치 전에 거부.
    let payload = vec![b'a'; MAX_PAYLOAD_BYTES + 1];
    let (ok, err) = unsafe { ffi_invoke_json(&payload) };
    assert!(!ok, "over-limit payload must return ok=false");
    let err = err.expect("over-limit payload must carry an error message");
    // (T3 후속) 코드 통일 — "payload.too_large: payload NB exceeds max payload LB".
    assert!(
        err.starts_with("payload.too_large: "),
        "over-limit error must carry the payload.too_large code prefix, got: {err}"
    );
    assert!(
        err.contains("exceeds max payload"),
        "over-limit error should mention the limit context, got: {err}"
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

// ── (T3) 동적 페이로드 한도 ─────────────────────────────────

/// 한도 변경 테스트 직렬화 + 원복 guard — 기존 1MiB 가정 테스트와의 경합 방지.
///
/// 이 테스트 바이너리의 테스트들은 병렬로 실행되고 `MAX_PAYLOAD_BYTES` 는
/// 프로세스 전역 atomic 이다. 한도를 바꾸는 테스트뿐 아니라 **기본 1 MiB 를
/// 가정하는**(at-limit/over-limit) 테스트도 이 뮤텍스를 잡아 서로 직렬화한다.
/// [`LimitGuard`] 의 drop 이 한도를 1 MiB 로 원복하므로, 어설션 실패로 인한
/// 조기 반환(unwrap panic 포함) 이후에도 다음 테스트가 오염된 한도를 보지
/// 않는다.
static LIMIT_MUTEX: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// `LIMIT_MUTEX` guard — drop 에서 한도를 기본 1 MiB 로 원복한다.
/// 필드는 락 홀드 자체가 목적이라 읽히지 않는다 (RAII).
#[allow(dead_code)]
struct LimitGuard(std::sync::MutexGuard<'static, ()>);

impl Drop for LimitGuard {
    fn drop(&mut self) {
        unsafe { rustra_ffi_set_max_payload(1024 * 1024) };
    }
}

/// 뮤텍스를 잡은 뒤 한도를 기준 상태(1 MiB)로 되돌리고 guard 를 반환한다.
/// "시작 전 원복"은 이전 테스트가 panic 으로 무너진 경우의 보험이다 — panic
/// unwinding 은 [`LimitGuard`] 의 `Drop` 을 실행해 한도를 원복하지만, 그 panic
/// 이 뮤텍스를 **독(poison)** 으로 만들기 때문에 이후 `.expect` 로는 락을 잡을
/// 수 없다. `into_inner` 로 독을 회복해야 이 원복이 다음 테스트에서 실제로
/// 의미를 갖는다.
fn limit_guard() -> LimitGuard {
    let guard = LIMIT_MUTEX.lock().unwrap_or_else(|e| e.into_inner()); // 포이즈닝 회복
    unsafe { rustra_ffi_set_max_payload(1024 * 1024) };
    LimitGuard(guard)
}

#[test]
fn default_limit_is_one_mib_and_set_get_round_trips() {
    let _guard = limit_guard();
    assert_eq!(unsafe { rustra_ffi_get_max_payload() }, 1024 * 1024);
    unsafe { rustra_ffi_set_max_payload(4 * 1024 * 1024) };
    assert_eq!(unsafe { rustra_ffi_get_max_payload() }, 4 * 1024 * 1024);
    // 원복은 guard drop 에서 (Drop 구현) — 다른 테스트 오염 방지.
}

#[test]
fn raised_limit_admits_previously_rejected_payload() {
    let _guard = limit_guard();
    register_ffi_for_boundary_tests();
    unsafe { rustra_ffi_set_max_payload(2 * 1024 * 1024) };
    // 1.5MB — 기본 1 MiB 한도에서는 거부되던 크기. 상향 후에는 크기 가드를
    // 통과하고 JSON 파싱에서 실패해야 한다 (에러 응답은 여전히 non-null).
    let payload = vec![b'{'; 1_500_000];
    let mut out_len = 0;
    let ptr = unsafe { rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len) };
    assert!(
        !ptr.is_null(),
        "raised limit must admit 1.5MB — clean JSON-decode error response, not null"
    );
    let resp = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let text = String::from_utf8_lossy(resp);
    // 정상 파이프라인 적중을 긍정적으로 고정: 크기 가드가 아니라 **JSON 파싱**
    // 단계에서 실패한 것이다 (ok=false + decode 에러). 한도 에러 부재만으로는
    // "다른 이유로 null 아닌 응답" 과 구별되지 않는다.
    let parsed: Value = serde_json::from_slice(resp).expect("response must be valid JSON");
    assert_eq!(
        parsed.get("ok").and_then(|v| v.as_bool()),
        Some(false),
        "1.5MB of '{{' must fail as JSON decode, got: {text}"
    );
    assert!(
        text.contains("json decode failed"),
        "error must come from the normal decode pipeline, got: {text}"
    );
    assert!(
        !text.contains("size limit"),
        "within raised limit — decode error is fine, limit error is not. got: {text}"
    );
    unsafe { rustra_ffi_free(ptr, out_len) };
}

#[test]
fn lowered_limit_rejects_with_size_error() {
    let _guard = limit_guard();
    register_ffi_for_boundary_tests();
    unsafe { rustra_ffi_set_max_payload(1024) };
    // 2048바이트 — 기본 한도에서는 문제없던 크기. 하향(1024) 후에는 크기
    // 가드가 디스패치 전에 거부해야 한다.
    let payload = vec![b'a'; 2048];
    let mut out_len = 0;
    let ptr = unsafe { rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len) };
    assert!(
        !ptr.is_null(),
        "size-limit rejection must be a clean error response"
    );
    let resp = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let text = String::from_utf8_lossy(resp);
    // (T3 후속) 코드 통일 — 평문 대신 payload.too_large 코드 프리픽스.
    assert!(text.contains("payload.too_large"));
    assert!(text.contains("exceeds max payload"));
    unsafe { rustra_ffi_free(ptr, out_len) };
}

// ── (T3 후속) rkyv V2 경로 크기 게이트 ───────────────────────

/// V2 게이트 테스트 공용 — `robustness_package()` 의 `add` 명령(cmd_id 조회).
/// 바디는 0xff 로 채운다 — continuation 비트가 켜진 varint 라 postcard 디코드가
/// 반드시 실패한다 (게이트 통과 후 "정상 파이프라인 실패" 를 만드는 용도).
fn v2_request(id: u16, body_len: usize) -> Vec<u8> {
    let mut req = vec![0xffu8; 2 + body_len];
    req[0..2].copy_from_slice(&id.to_le_bytes());
    req
}

#[test]
fn invoke_rkyv_v2_over_limit_returns_payload_too_large_code() {
    let _guard = limit_guard();
    let pkg = robustness_package();
    let id = common::command_id_of(&pkg, "add");
    // 기본 1 MiB + 1 바이트 — V2 게이트가 디스패치 전에 거부해야 한다.
    let req = v2_request(id, 1024 * 1024 - 1);
    let err = pkg
        .invoke_rkyv_v2(&req)
        .expect_err("over-limit V2 payload must error");
    assert_eq!(err.code(), "payload.too_large");
    assert_eq!(
        err.message(),
        format!(
            "payload {}B exceeds max payload {}B",
            req.len(),
            1024 * 1024
        )
    );
    // rkyv V2 에러 와이어로 인코딩해도 코드가 살아남는다 — JS codec 이 복원하는 형태.
    let frame = rustra::encode_rkyv_v2_error(&err);
    assert_eq!(frame[0], 0, "error frame ok flag must be 0");
}

#[test]
fn invoke_rkyv_v2_lowered_limit_applies_immediately() {
    let _guard = limit_guard();
    let pkg = robustness_package();
    let id = common::command_id_of(&pkg, "add");
    unsafe { rustra_ffi_set_max_payload(1024) };
    // 2048바이트 — 기본 한도에서는 postcard decode 단계까지 갈 크기. 하향
    // 후에는 V2 게이트가 먼저 거부한다.
    let req = v2_request(id, 2048);
    let err = pkg
        .invoke_rkyv_v2(&req)
        .expect_err("lowered limit must reject");
    assert_eq!(
        err.code(),
        "payload.too_large",
        "V2 gate must reflect the dynamic limit immediately"
    );
    // 상향하면 같은 크기가 게이트를 통과하고 정상 파이프라인(postcard decode
    // 실패)으로 간다 — 게이트가 아니라 디코더에서 실패한 것이다.
    unsafe { rustra_ffi_set_max_payload(4096) };
    let err2 = pkg
        .invoke_rkyv_v2(&req)
        .expect_err("garbage body must still error");
    assert_ne!(
        err2.code(),
        "payload.too_large",
        "within raised limit the failure must come from the decode pipeline, got: {err2}"
    );
}

#[test]
fn invoke_rkyv_v2_at_limit_passes_gate_into_pipeline() {
    let _guard = limit_guard();
    let pkg = robustness_package();
    let id = common::command_id_of(&pkg, "add");
    // ==limit — `>` 검사를 통과한다. 본체는 쓰레기 postcard(0xff) 이므로 정상
    // 파이프라인에서 invalid_args 로 실패한다 (게이트가 아닌 디코더 실패).
    let req = v2_request(id, 1024 * 1024 - 2);
    let err = pkg
        .invoke_rkyv_v2(&req)
        .expect_err("at-limit garbage body must fail in the pipeline");
    assert_ne!(
        err.code(),
        "payload.too_large",
        "at-limit payload must not hit the gate, got: {err}"
    );
}
