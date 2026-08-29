use super::*;
use crate::Package;

fn test_package() -> Package {
    Package::builder("test.ffi")
        .command("addNumbers", |args: serde_json::Value| {
            let a = args["a"].as_i64().unwrap_or(0);
            let b = args["b"].as_i64().unwrap_or(0);
            Ok::<_, crate::RustraError>(serde_json::json!(a + b))
        })
        .build()
}

/// 채널 FFI 왕복 — C ABI 콜백으로 등록한 핸들에 send 가 도달하고,
/// drop 후에는 0(stale) 을 반환한다. 핸들 공간은 전역이므로 각 테스트가
/// 서로 독립된 핸들을 쓴다(단조 증가 보장). 콜백 두 번째 인자(handle)로
/// 발급 번호가 그대로 회신되는 것도 함께 검증한다.
#[test]
fn ffi_channel_round_trip() {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

    static HITS: AtomicUsize = AtomicUsize::new(0);
    static SEEN: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());
    static GOT_HANDLE: AtomicU32 = AtomicU32::new(0);

    unsafe extern "C" fn cb(_ud: *mut c_void, handle: u32, payload: *const c_char) {
        HITS.fetch_add(1, Ordering::Relaxed);
        GOT_HANDLE.store(handle, Ordering::Relaxed);
        let s = unsafe { std::ffi::CStr::from_ptr(payload) }
            .to_string_lossy()
            .into_owned();
        SEEN.lock().unwrap().push((handle, s));
    }

    let handle = unsafe { rustra_ffi_channel_create(cb, std::ptr::null_mut()) };
    assert!(handle >= 1, "핸들은 1부터 단조 증가");

    let sent = unsafe {
        let c = std::ffi::CString::new(r#"{"step":1,"of":2}"#).unwrap();
        rustra_ffi_channel_send(handle, c.as_ptr())
    };
    assert_eq!(sent, 1);
    assert_eq!(HITS.load(Ordering::Relaxed), 1);
    // 콜백 회신 handle == 발급 handle — 호스트가 핸들→JS 콜백 룩업의 키.
    assert_eq!(GOT_HANDLE.load(Ordering::Relaxed), handle);
    assert_eq!(SEEN.lock().unwrap()[0].1, r#"{"step":1,"of":2}"#);

    // drop 후 stale send 는 0 — 콜백 미도달.
    assert_eq!(unsafe { rustra_ffi_channel_drop(handle) }, 1);
    let stale = unsafe {
        let c = std::ffi::CString::new("x").unwrap();
        rustra_ffi_channel_send(handle, c.as_ptr())
    };
    assert_eq!(stale, 0);
    assert_eq!(HITS.load(Ordering::Relaxed), 1, "stale send 는 콜백 미도달");
    // double drop 은 0.
    assert_eq!(unsafe { rustra_ffi_channel_drop(handle) }, 0);
}

struct SlowChannelCallback {
    entered: std::sync::Barrier,
    release: std::sync::Barrier,
}

unsafe extern "C" fn slow_channel_cb(
    user_data: *mut c_void,
    _handle: u32,
    _payload: *const c_char,
) {
    let state = unsafe { &*(user_data as *const SlowChannelCallback) };
    state.entered.wait();
    state.release.wait();
}

#[test]
fn ffi_channel_drop_waits_until_user_data_is_quiescent() {
    let state = std::sync::Arc::new(SlowChannelCallback {
        entered: std::sync::Barrier::new(2),
        release: std::sync::Barrier::new(2),
    });
    let handle = unsafe {
        rustra_ffi_channel_create(
            slow_channel_cb,
            std::sync::Arc::as_ptr(&state) as *mut c_void,
        )
    };
    let send = std::thread::spawn(move || unsafe {
        let payload = std::ffi::CString::new("slow").unwrap();
        rustra_ffi_channel_send(handle, payload.as_ptr())
    });
    state.entered.wait();

    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let dropper = std::thread::spawn(move || {
        let dropped = unsafe { rustra_ffi_channel_drop(handle) };
        done_tx.send(dropped).unwrap();
    });
    assert!(
        done_rx
            .recv_timeout(std::time::Duration::from_millis(25))
            .is_err(),
        "drop must wait while callback still owns user_data",
    );

    state.release.wait();
    assert_eq!(
        done_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("drop must finish after callback returns"),
        1,
    );
    assert_eq!(send.join().unwrap(), 1);
    dropper.join().unwrap();
    drop(state);
}

#[test]
fn ffi_json_round_trip() {
    let pkg = test_package();
    pkg.register_ffi();

    let request = serde_json::json!({"command": "addNumbers", "args": {"a": 20, "b": 22}});
    let payload = serde_json::to_vec(&request).unwrap();
    let mut out_len: usize = 0;

    let ptr = unsafe { rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len) };

    assert!(!ptr.is_null());
    assert!(out_len > 0);

    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let resp: FfiResponse = serde_json::from_slice(bytes).unwrap();
    assert!(resp.ok);
    assert_eq!(resp.result.unwrap(), 42);

    unsafe { rustra_ffi_free(ptr, out_len) };
}

#[test]
fn ffi_postcard_round_trip() {
    let pkg = test_package();
    pkg.register_ffi();

    // 1. Direct postcard call
    let envelope = FfiPostcardEnvelope {
        command: "addNumbers".into(),
        args_json: serde_json::to_string(&serde_json::json!({"a": 20, "b": 22})).unwrap(),
    };
    let payload = postcard::to_allocvec(&envelope).unwrap();
    let mut out_len: usize = 0;

    let ptr = unsafe { rustra_ffi_invoke_postcard(payload.as_ptr(), payload.len(), &mut out_len) };

    assert!(!ptr.is_null());
    assert!(out_len > 0);

    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let resp: FfiPostcardResponse = postcard::from_bytes(bytes).unwrap();
    assert!(resp.ok);
    let result: serde_json::Value = serde_json::from_str(&resp.result_json.unwrap()).unwrap();
    assert_eq!(result, 42);

    unsafe { rustra_ffi_free(ptr, out_len) };

    // 2. Default dispatches to postcard
    let envelope2 = FfiPostcardEnvelope {
        command: "addNumbers".into(),
        args_json: serde_json::to_string(&serde_json::json!({"a": 10, "b": 15})).unwrap(),
    };
    let payload2 = postcard::to_allocvec(&envelope2).unwrap();
    let mut out_len2: usize = 0;

    let ptr2 = unsafe { rustra_ffi_invoke(payload2.as_ptr(), payload2.len(), &mut out_len2) };
    assert!(!ptr2.is_null());

    let bytes2 = unsafe { std::slice::from_raw_parts(ptr2, out_len2) };
    let resp2: FfiPostcardResponse = postcard::from_bytes(bytes2).unwrap();
    assert!(resp2.ok);
    let result2: serde_json::Value = serde_json::from_str(&resp2.result_json.unwrap()).unwrap();
    assert_eq!(result2, 25);

    unsafe { rustra_ffi_free(ptr2, out_len2) };
}

#[test]
fn ffi_null_payload_returns_null() {
    let pkg = test_package();
    pkg.register_ffi();

    let mut out_len: usize = 0;
    let ptr = unsafe { rustra_ffi_invoke(std::ptr::null(), 0, &mut out_len) };
    assert!(ptr.is_null());
}

#[test]
fn ffi_unknown_command_returns_error() {
    let pkg = test_package();
    pkg.register_ffi();

    let request = serde_json::json!({"command": "nonexistent", "args": {}});
    let payload = serde_json::to_vec(&request).unwrap();
    let mut out_len: usize = 0;

    let ptr = unsafe { rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len) };
    assert!(!ptr.is_null());

    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let resp: FfiResponse = serde_json::from_slice(bytes).unwrap();
    assert!(!resp.ok);
    assert!(resp.error.unwrap().contains("not found"));

    unsafe { rustra_ffi_free(ptr, out_len) };
}

#[test]
fn ffi_get_schema_returns_live_schema() {
    let pkg = test_package();
    pkg.register_ffi();

    let mut out_len: usize = 0;
    let ptr = unsafe { rustra_ffi_get_schema(&mut out_len) };
    assert!(!ptr.is_null());
    assert!(out_len > 0);

    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let v: serde_json::Value = serde_json::from_slice(bytes).unwrap();
    assert_eq!(v["packageId"], "test.ffi");
    assert!(
        v["commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "addNumbers")
    );

    unsafe { rustra_ffi_free(ptr, out_len) };
}

// ── rustra_ffi_event_sink_register / unregister ─────────────
//
// 전역 FFI_CONTEXT / FFI_EVENT_SINK 을 공유하므로 병렬 테스트 간 간섭이 생긴다
// (FFI_CONTEXT.set 은 첫 등록만 유효 — 이후 테스트의 패키지는 전역에 반영되지
// 않는다). 따라서 상태 전이 전체(등록 → emit 수신 → 해제 → 폴링 복귀)를
// 하나의 순차 테스트로 완결하고, 전역 락으로 다른 sink 테스트와 상호배제한다.

/// 전역 FFI_CONTEXT 가 이미 등록되어 있으면 그것을, 아니면 지금 등록한다.
/// (register_ffi 는 idempotent — 첫 호출이 이긴다.)
fn ensure_global_package() -> Package {
    let pkg = test_package();
    pkg.register_ffi();
    get_package().expect("package must be registered").clone()
}

/// C 콜백이 (name, payload) 를 그대로 수신하는지 검증한다.
unsafe extern "C-unwind" fn record_event_cb(
    user_data: *mut c_void,
    name: *const c_char,
    payload: *const c_char,
) {
    let seen = unsafe { &*(user_data as *const Mutex<Vec<(String, String)>>) };
    let name = unsafe { std::ffi::CStr::from_ptr(name) }
        .to_string_lossy()
        .into_owned();
    let payload = unsafe { std::ffi::CStr::from_ptr(payload) }
        .to_string_lossy()
        .into_owned();
    seen.lock().unwrap().push((name, payload));
}

struct SlowEventCallback {
    entered: std::sync::Barrier,
    release: std::sync::Barrier,
}

unsafe extern "C-unwind" fn slow_event_cb(
    user_data: *mut c_void,
    _name: *const c_char,
    _payload: *const c_char,
) {
    let state = unsafe { &*(user_data as *const SlowEventCallback) };
    state.entered.wait();
    state.release.wait();
}

/// sink 테스트 간 상호배제 락 — 등록/해제가 전역 상태를 공유하므로.
static SINK_TEST_MUTEX: Mutex<()> = Mutex::new(());

#[test]
fn ffi_event_sink_register_receives_emit_and_bypasses_bus() {
    let _guard = SINK_TEST_MUTEX.lock().unwrap();
    let pkg = ensure_global_package();

    let seen: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
    unsafe { rustra_ffi_event_sink_register(record_event_cb, &seen as *const _ as *mut c_void) };

    pkg.emit("progress.tick", serde_json::json!({ "value": 42 }));

    let events = seen.lock().unwrap().clone();
    assert_eq!(events.len(), 1, "C callback must receive the emit");
    assert_eq!(events[0].0, "progress.tick");
    let payload: serde_json::Value = serde_json::from_str(&events[0].1).unwrap();
    assert_eq!(payload["value"], 42);
    assert!(
        pkg.event_bus().take_pending_events().is_empty(),
        "sink installed → bus must stay empty"
    );

    // 정리 — 이후 테스트가 폴링 경로에서 시작하도록.
    unsafe { rustra_ffi_event_sink_unregister() };
}

#[test]
fn ffi_event_sink_unregister_restores_polling() {
    let _guard = SINK_TEST_MUTEX.lock().unwrap();
    let pkg = ensure_global_package();

    let seen: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
    unsafe { rustra_ffi_event_sink_register(record_event_cb, &seen as *const _ as *mut c_void) };
    pkg.emit("a", serde_json::json!({ "n": 1 }));
    unsafe { rustra_ffi_event_sink_unregister() };

    pkg.emit("b", serde_json::json!({ "n": 2 }));

    assert_eq!(
        seen.lock().unwrap().len(),
        1,
        "only pre-unregister emit hits the callback"
    );
    let polled = pkg.event_bus().take_pending_events();
    assert_eq!(polled.len(), 1, "post-unregister emit must go to the bus");
    assert_eq!(polled[0].name, "b");
}

#[test]
fn ffi_event_sink_unregister_waits_until_user_data_is_quiescent() {
    let _guard = SINK_TEST_MUTEX.lock().unwrap();
    let pkg = ensure_global_package();
    let state = std::sync::Arc::new(SlowEventCallback {
        entered: std::sync::Barrier::new(2),
        release: std::sync::Barrier::new(2),
    });
    unsafe {
        rustra_ffi_event_sink_register(slow_event_cb, std::sync::Arc::as_ptr(&state) as *mut c_void)
    };

    let emit_pkg = pkg.clone();
    let emit = std::thread::spawn(move || emit_pkg.emit("slow", serde_json::json!({})));
    state.entered.wait();

    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let unregister = std::thread::spawn(move || {
        unsafe { rustra_ffi_event_sink_unregister() };
        done_tx.send(()).unwrap();
    });
    assert!(
        done_rx
            .recv_timeout(std::time::Duration::from_millis(25))
            .is_err(),
        "unregister must not return while callback still owns user_data",
    );

    state.release.wait();
    done_rx
        .recv_timeout(std::time::Duration::from_secs(1))
        .expect("unregister must finish after callback returns");
    emit.join().unwrap();
    unregister.join().unwrap();
    // unregister 반환 뒤 Arc를 즉시 drop해도 더 이상 callback이 없다.
    drop(state);
}

#[test]
fn ffi_event_sink_panicking_callback_does_not_break_emit() {
    let _guard = SINK_TEST_MUTEX.lock().unwrap();
    let pkg = ensure_global_package();

    unsafe extern "C-unwind" fn panic_cb(
        _user_data: *mut c_void,
        _name: *const c_char,
        _payload: *const c_char,
    ) {
        panic!("host callback exploded");
    }
    unsafe { rustra_ffi_event_sink_register(panic_cb, std::ptr::null_mut()) };

    // 패닉이 emit 호출자로 전파되지 않아야 한다 (deliver_via_sink 가 격리).
    pkg.emit("boom", serde_json::json!({ "n": 1 }));
    pkg.emit("boom", serde_json::json!({ "n": 2 }));

    unsafe { rustra_ffi_event_sink_unregister() };
}

#[test]
fn ffi_event_sink_register_before_package_defers_install() {
    let _guard = SINK_TEST_MUTEX.lock().unwrap();
    // 등록 순서가 반대인 경우: 싱크 먼저 → 패키지 등록 나중.
    // register_ffi_with_default 이 지연 설치를 이어받아야 한다.
    // (전역 FFI_CONTEXT 는 다른 테스트가 이미 등록했을 수 있다 — 어느 쪽이든
    //  지연 설치 경로가 동일하게 검증된다: FFI_EVENT_SINK 상태만 확인.)
    unsafe { rustra_ffi_event_sink_unregister() }; // 깨끗한 상태에서 시작
    let seen: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
    unsafe { rustra_ffi_event_sink_register(record_event_cb, &seen as *const _ as *mut c_void) };

    let pkg = ensure_global_package();

    pkg.emit("late.register", serde_json::json!({ "ok": true }));

    let events = seen.lock().unwrap().clone();
    assert_eq!(
        events.len(),
        1,
        "deferred install must connect the C sink on register_ffi"
    );
    assert_eq!(events[0].0, "late.register");

    unsafe { rustra_ffi_event_sink_unregister() };
    pkg.emit("after", serde_json::json!({ "n": 3 }));
    assert_eq!(pkg.event_bus().take_pending_events().len(), 1);
}

// ── run_worker 취소 체크포인트 (경합 없는 결정적 검증) ──────
//
// FFI async 엔트리는 워커 스레드 스케줄링 경합 때문에 "cancel 먼저" 순서를
// 강제할 수 없다. 대신 run_worker 를 직접 호출해 레지스트리가 이미
// Cancelled 인 경우를 결정적으로 검증한다: invoke_fn 은 절대 실행되지
// 않아야 하고, on_complete 로는 cancelled 에러 프레임이 전달되어야 한다.

/// 더미 invoke_fn — 실행됐다면 플래그를 올린다 (절대 false 여야 함).
static WORKER_INVOKE_RAN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

unsafe extern "C" fn sentinel_invoke(
    _payload: *const u8,
    _len: usize,
    _out_len: *mut usize,
) -> *mut u8 {
    WORKER_INVOKE_RAN.store(true, std::sync::atomic::Ordering::SeqCst);
    std::ptr::null_mut()
}

/// on_complete 로 전달된 버퍼를 Vec 으로 캡처한다. null 버퍼로 호출된
/// 경우에도 콜백 자체는 발생했음을 플래그로 기록한다.
static WORKER_FRAME: Mutex<Option<(Vec<u8>, usize)>> = Mutex::new(None);
static WORKER_CB_FIRED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

unsafe extern "C" fn capture_frame_cb(_user: *mut c_void, ptr: *mut u8, len: usize) {
    WORKER_CB_FIRED.store(true, std::sync::atomic::Ordering::SeqCst);
    if ptr.is_null() {
        return;
    }
    let data = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    unsafe { rustra_ffi_free(ptr, len) };
    *WORKER_FRAME.lock().unwrap() = Some((data, len));
}

/// run_worker 테스트 간 상호배제 — 플래그/프레임 셀이 공유 static 이므로
/// 병렬 실행 시 서로의 상태를 덮어쓴다 (SINK_TEST_MUTEX 와 같은 패턴).
static WORKER_TEST_MUTEX: Mutex<()> = Mutex::new(());

#[test]
fn run_worker_pre_cancelled_skips_invoke_and_returns_cancelled_frame() {
    let _guard = WORKER_TEST_MUTEX.lock().unwrap();
    let id = crate::cancel::register_invocation();
    assert!(crate::cancel::cancel_invocation(id));

    WORKER_INVOKE_RAN.store(false, std::sync::atomic::Ordering::SeqCst);
    WORKER_FRAME.lock().unwrap().take();

    run_worker(
        id,
        Vec::new(),
        0,
        Some(capture_frame_cb),
        sentinel_invoke,
        json_serialize,
    );

    assert!(
        !WORKER_INVOKE_RAN.load(std::sync::atomic::Ordering::SeqCst),
        "pre-cancelled invocation must never start the handler"
    );
    let (frame, len) = WORKER_FRAME
        .lock()
        .unwrap()
        .take()
        .expect("on_complete must deliver the cancelled frame");
    let resp: FfiResponse = serde_json::from_slice(&frame).unwrap();
    assert!(!resp.ok);
    assert_eq!(resp.result, None);
    assert_eq!(
        resp.error.as_deref(),
        Some("cancelled: invocation cancelled before dispatch"),
        "cancelled frame must carry the stable `cancelled: ` prefix"
    );
    assert_eq!(frame.len(), len);
    assert_eq!(
        crate::cancel::status(id),
        crate::cancel::Status::Unknown,
        "complete_invocation must clear the registry entry"
    );
}

#[test]
fn run_worker_running_invocation_dispatches_normally() {
    let _guard = WORKER_TEST_MUTEX.lock().unwrap();
    let id = crate::cancel::register_invocation();

    WORKER_INVOKE_RAN.store(false, std::sync::atomic::Ordering::SeqCst);
    WORKER_FRAME.lock().unwrap().take();
    WORKER_CB_FIRED.store(false, std::sync::atomic::Ordering::SeqCst);

    run_worker(
        id,
        Vec::new(),
        0,
        Some(capture_frame_cb),
        sentinel_invoke,
        json_serialize,
    );

    assert!(
        WORKER_INVOKE_RAN.load(std::sync::atomic::Ordering::SeqCst),
        "running invocation must reach the handler"
    );
    // WORKER_FRAME.is_none() 만으로는 "콜백이 null 버퍼로 호출됨"과
    // "아예 호출 안 됨"을 구분할 수 없다 — 플래그로 실제 발생을 증명한다.
    assert!(
        WORKER_CB_FIRED.load(std::sync::atomic::Ordering::SeqCst),
        "sentinel returns null → on_complete must still fire (with a null buffer)"
    );
    assert!(
        WORKER_FRAME.lock().unwrap().is_none(),
        "null buffer must not be captured as a frame"
    );
    assert_eq!(crate::cancel::status(id), crate::cancel::Status::Unknown);
}
