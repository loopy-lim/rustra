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

/// async 응답 프레임을 기다리는 테스트 간 상호배제 — RECEIVED 셀이 하나뿐이라
/// 병렬 실행 시 서로의 프레임을 훔친다 (ffi.rs sink 테스트와 같은 패턴).
static ASYNC_TEST_MUTEX: Mutex<()> = Mutex::new(());

/// RECEIVED 를 비운다 — OnceLock::set 은 첫 채움만 유효하므로 이전 테스트의
/// 잔여 프레임을 drain 해야 한다.
fn reset_received() {
    let _ = RECEIVED.set(Mutex::new(None));
    let _ = RECEIVED
        .get_or_init(|| Mutex::new(None))
        .lock()
        .unwrap()
        .take();
}

#[test]
fn async_invoke_issues_id_and_cancel_flips_status() {
    let _guard = ASYNC_TEST_MUTEX.lock().unwrap();
    let pkg = cancellation_package();
    pkg.register_ffi();
    reset_received();

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
    // 워커가 invoke 를 마치고 complete_invocation 까지 끝낸 뒤라면 cancel 은
    // false 다 — 그 경우 상태는 0(Unknown)이어야 한다. 둘의 조합만 계약 내.
    let cancelled = unsafe { rustra_ffi_invoke_cancel(invocation_id) };
    let s = unsafe { rustra_ffi_cancellation_status(invocation_id) };
    assert!(
        cancelled || s == 0,
        "cancel false must mean already-completed (status 0), got {s}"
    );

    // 상태 폴링 심볼: 1=Running 2=Cancelled 0=Unknown — cancel 후엔
    // 완료 전이면 2, 완료 후(레지스트리 제거)면 0. 둘 다 계약 내.
    assert!(
        s == 2 || s == 0,
        "status after cancel is Cancelled(2) pre-completion or Unknown(0) post-completion, got {s}"
    );

    // 응답은 반드시 도착해야 한다 — dispatch 체크포인트 도입 후 취소가 먼저면
    // cancelled 에러 프레임, 체크포인트 통과 후 취소면 정상 결과다 (둘 다 계약 내).
    // 이 테스트의 초점은 id/상태 라이프사이클이므로 여기선 도착+디코드와
    // 브랜치별 최소 형태만 검증한다. 프레임 전체 계약은
    // pre_cancelled_invocation_short_circuits_before_handler 가 담당한다.
    // register_ffi 디폴트가 Postcard 이므로 async 응답은 postcard
    // FfiPostcardResponse 프레임이다 ("ok" 리터럴은 JSON 경로에만 있다).
    let resp = wait_for_response(2_000).expect("on_complete must fire");
    #[derive(serde::Deserialize, Debug)]
    struct TestResponse {
        ok: bool,
        result_json: Option<String>,
        error: Option<String>,
    }
    let decoded: TestResponse = postcard::from_bytes(&resp).expect("postcard response must decode");
    if decoded.ok {
        assert_eq!(
            decoded.result_json.as_deref(),
            Some(r#"{"value":3}"#),
            "handler ran to completion: add(1,2)=3"
        );
        assert_eq!(decoded.error, None);
    } else {
        assert!(
            decoded
                .error
                .as_deref()
                .is_some_and(|e| e.starts_with("cancelled: ")),
            "non-ok response must be the cancelled frame, got {decoded:?}"
        );
    }
}

#[test]
fn cancel_of_unknown_id_is_false_and_status_zero() {
    // 전역 패키지 등록 상태와 무관하게 미발급 ID 는 거짓/0 이어야 한다.
    cancellation_package().register_ffi();
    assert!(!unsafe { rustra_ffi_invoke_cancel(u64::MAX) });
    assert_eq!(unsafe { rustra_ffi_cancellation_status(u64::MAX) }, 0);
}

#[test]
fn pre_cancelled_invocation_short_circuits_before_handler() {
    let _guard = ASYNC_TEST_MUTEX.lock().unwrap();
    // 협력적 취소의 이중 계약 (dispatch 체크포인트 문서화):
    //
    // (a) cancel 이 워커의 체크포인트보다 먼저 도달 → 핸들러 미실행,
    //     `cancelled: ...` 에러 프레임이 on_complete 로 전달.
    // (b) 체크포인트 통과 후 cancel 도달 → 핸들러는 끝까지 실행되고
    //     정상 결과가 전달된다.
    //
    // FFI 엔트리는 워커 스레드 스케줄링 경합이 있으므로 여기서는 두 결과
    // 모두 계약 내로 검증한다. "핸들러 절대 미실행 + cancelled 프레임"의
    // 결정적 검증은 ffi.rs 의 run_worker 인라인 단위 테스트가 담당한다.
    let pkg = cancellation_package();
    pkg.register_ffi();
    reset_received();

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
    let cancelled = unsafe { rustra_ffi_invoke_cancel(invocation_id) };

    let resp = wait_for_response(2_000).expect("on_complete must fire");
    #[derive(serde::Deserialize, Debug)]
    struct TestResponse {
        ok: bool,
        result_json: Option<String>,
        error: Option<String>,
    }
    let decoded: TestResponse = postcard::from_bytes(&resp).expect("postcard response must decode");

    if !decoded.ok {
        // (a) cancel 이 체크포인트보다 먼저 — cancelled 에러 프레임.
        assert!(
            decoded
                .error
                .as_deref()
                .is_some_and(|e| e.starts_with("cancelled: ")),
            "error must carry the stable `cancelled: ` prefix, got {decoded:?}"
        );
        assert_eq!(
            decoded.result_json, None,
            "short-circuited response must not run the handler: {decoded:?}"
        );
        // add(1,2) 는 실패할 수 없는 핸들러 — 실패 프레임은 취소 경로뿐이다.
        assert!(
            cancelled,
            "a non-ok response is only reachable when cancel won the registry race"
        );
    } else {
        // 체크포인트가 이미 통과됐다 — 정상 완결이 계약 (add(1,2)=3).
        assert!(
            decoded.ok,
            "post-checkpoint cancel must still deliver the success result: {decoded:?}"
        );
        assert_eq!(decoded.result_json.as_deref(), Some(r#"{"value":3}"#));
    }
}
