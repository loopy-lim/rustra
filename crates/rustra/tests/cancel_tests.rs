//! 트랙 1 — FFI 취소 파이프라인 (별도 바이너리: OnceLock 전역 격리).
//!
//! `rustra_ffi_invoke_async` 가 발급하는 invocation_id 로
//! `rustra_ffi_invoke_cancel` / `rustra_ffi_cancellation_status` 를 구동한다.
//! 같은 바이너리 내 테스트는 OnceLock 글로벌 패키지를 공유하므로 두 테스트 모두
//! 동일한 패키지 정의를 register 한다 (register_ffi 는 idempotent, first-wins).

use rustra::Package;
use rustra::ffi::{
    rustra_ffi_cancellation_status, rustra_ffi_free, rustra_ffi_invoke_async,
    rustra_ffi_invoke_cancel,
};
use std::ffi::c_void;
use std::sync::Mutex;
use std::sync::OnceLock;

#[path = "../benches/common.rs"]
mod common;

fn cancellation_package() -> Package {
    Package::builder("cancel.test")
        .command("add", common::add)
        .build()
}

static RECEIVED: OnceLock<Mutex<Option<Vec<u8>>>> = OnceLock::new();

unsafe extern "C" fn on_complete(_user: *mut c_void, ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let slice = unsafe { std::slice::from_raw_parts(ptr, len) };
    let data = slice.to_vec();
    unsafe { rustra_ffi_free(ptr, len) };
    *RECEIVED.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(data);
}

fn encode_envelope(command: &str, args_json: &str) -> Vec<u8> {
    #[derive(serde::Serialize)]
    struct TestEnvelope {
        command: String,
        args_json: String,
    }
    postcard::to_allocvec(&TestEnvelope {
        command: command.into(),
        args_json: args_json.into(),
    })
    .unwrap()
}

fn wait_for_response(timeout_ms: u64) -> Option<Vec<u8>> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    while std::time::Instant::now() < deadline {
        if let Some(data) = RECEIVED
            .get_or_init(|| Mutex::new(None))
            .lock()
            .unwrap()
            .take()
        {
            return Some(data);
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    None
}

#[test]
fn async_invoke_issues_id_and_cancel_flips_status() {
    let pkg = cancellation_package();
    pkg.register_ffi();
    let _ = RECEIVED.set(Mutex::new(None));

    let envelope = encode_envelope("add", r#"{"a":1,"b":2}"#);
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
    assert!(
        unsafe { rustra_ffi_invoke_cancel(invocation_id) },
        "cancel on a live invocation returns true"
    );

    // 상태 폴링 심볼: 1=Running 2=Cancelled 0=Unknown — cancel 후엔
    // 완료 전이면 2, 완료 후(레지스트리 제거)면 0. 둘 다 계약 내.
    let s = unsafe { rustra_ffi_cancellation_status(invocation_id) };
    assert!(
        s == 2 || s == 0,
        "status after cancel is Cancelled(2) pre-completion or Unknown(0) post-completion, got {s}"
    );

    // 응답은 반드시 도착해야 한다 (핸들러는 이미 종료했을 수 있어 정상 결과일 수 있음).
    // register_ffi 디폴트가 Postcard 이므로 async 응답도 postcard FfiPostcardResponse
    // 프레임이다 — 디코드해 정상 완결을 검증한다 ("ok" 리터럴은 JSON 경로에만 있다).
    let resp = wait_for_response(2_000).expect("on_complete must fire");
    #[derive(serde::Deserialize, Debug)]
    struct TestResponse {
        ok: bool,
        result_json: Option<String>,
        error: Option<String>,
    }
    let decoded: TestResponse = postcard::from_bytes(&resp).expect("postcard response must decode");
    assert!(decoded.ok, "response must be an ok envelope: {decoded:?}");
    assert_eq!(
        decoded.result_json.as_deref(),
        Some(r#"{"value":3}"#),
        "handler ran to completion: add(1,2)=3"
    );
    assert_eq!(decoded.error, None);
}

#[test]
fn cancel_of_unknown_id_is_false_and_status_zero() {
    // 전역 패키지 등록 상태와 무관하게 미발급 ID 는 거짓/0 이어야 한다.
    cancellation_package().register_ffi();
    assert!(!unsafe { rustra_ffi_invoke_cancel(u64::MAX) });
    assert_eq!(unsafe { rustra_ffi_cancellation_status(u64::MAX) }, 0);
}
