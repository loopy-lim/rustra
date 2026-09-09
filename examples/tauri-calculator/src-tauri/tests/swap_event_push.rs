//! 웹뷰 스왑 보고(headless) 검증 — `register_dispatch_with_swap_events`.
//!
//! `event_push.rs` 와 같은 `tauri::test::MockRuntime` 기법으로, 웹뷰/이벤트
//! 루프 없이 hot-core 스왑 보고 배선을 증명한다:
//!
//! 1. 플러그인 setup 이 `AppHandle` 싱크를 리포터에 설치하고, 그 뒤 어느
//!    스레드에서든 `HotSwapReporter::report` 가 `rustra://hot-core/swapped`
//!    채널로 도달한다(성공 `{oldContractHash,newContractHash}` / 실패 `{error}`).
//! 2. 페이로드는 JSON 문자열 그대로(패키지 이벤트와 같은 단일 직렬화 계약).
//! 3. 기존 `register_dispatch`(하위호환)는 보고 배선이 없다 — 리포터에 싱크가
//!    설치되지 않아 report 는 no-op 이고 채널 수신도 0건이다.
//! 4. report 는 부팅 전(싱크 미설치)에 호출돼도 패닉하지 않는다 — 감시 스레드가
//!    웹뷰 부팅을 기다리지 않고 스왑을 계속한다.

use rustra::hot_core::JsonDispatch;
use rustra::tauri_support::{self, EVENT_CHANNEL_PREFIX, HotSwapReporter};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use tauri::Listener;
use tauri::test::{MockRuntime, mock_context, noop_assets};

/// 스왑 채널 — 예약 세그먼트 이름(hot-core/swapped)은 Tauri 허용 문자뿐이라
/// 치환 없이 이 리터럴이 채널이 된다(Rust 단위 테스트 hot_swap_tests 도 고정).
const SWAP_CHANNEL: &str = "rustra://hot-core/swapped";

/// 디스패치를 안 하는 최소 구현 — 이 테스트의 대상은 커맨드가 아니라 보고 배선이다.
struct NullDispatch;

impl JsonDispatch for NullDispatch {
    fn invoke_json(&self, _command: &str, _args: Value) -> Result<Value, Value> {
        Err(json!({"code": "test.null_dispatch", "message": "no commands here"}))
    }
}

fn null_dispatch() -> Arc<dyn JsonDispatch> {
    Arc::new(NullDispatch)
}

type Received = Arc<Mutex<Vec<String>>>;

fn listen_on_swap_channel(app: &tauri::App<MockRuntime>) -> Received {
    let received: Received = Arc::new(Mutex::new(Vec::new()));
    let sink_received = Arc::clone(&received);
    app.listen(SWAP_CHANNEL, move |event| {
        sink_received
            .lock()
            .unwrap()
            .push(event.payload().to_string());
    });
    received
}

#[test]
fn swap_report_reaches_the_webview_channel() {
    let reporter = HotSwapReporter::new();
    let app = tauri_support::register_dispatch_with_swap_events(
        null_dispatch(),
        reporter.clone(),
        tauri::test::mock_builder(),
    )
    .build(mock_context(noop_assets()))
    .expect("mock app builds");
    let received = listen_on_swap_channel(&app);

    // 성공 + 실패 각 1건 — 두 모양 모두 웹뷰에 도달해야 한다.
    reporter.report(Ok(("0123456789abcdef".into(), "fedcba9876543210".into())));
    reporter.report(Err("dylib open failed".into()));

    let events = received.lock().unwrap().clone();
    assert_eq!(events.len(), 2, "성공/실패 보고 모두 채널에 도달한다");
    let success: Value = serde_json::from_str(&events[0]).unwrap();
    assert_eq!(success["oldContractHash"], json!("0123456789abcdef"));
    assert_eq!(success["newContractHash"], json!("fedcba9876543210"));
    let failure: Value = serde_json::from_str(&events[1]).unwrap();
    assert_eq!(failure["error"], json!("dylib open failed"));
}

#[test]
fn swap_report_flows_from_a_watch_like_background_thread() {
    // 실제 배선에서 report 는 감시 스레드가 호출한다 — AppHandle::emit 이
    // 스레드 안전하므로 백그라운드 스레드의 보고도 전달된다(event_push.rs 의
    // 스레드 계약 테스트와 동일 관용).
    let reporter = HotSwapReporter::new();
    let app = tauri_support::register_dispatch_with_swap_events(
        null_dispatch(),
        reporter.clone(),
        tauri::test::mock_builder(),
    )
    .build(mock_context(noop_assets()))
    .expect("mock app builds");
    let received = listen_on_swap_channel(&app);

    let worker = std::thread::spawn(move || {
        reporter.report(Ok(("old".into(), "new".into())));
    });
    worker.join().unwrap();

    assert_eq!(received.lock().unwrap().len(), 1);
}

#[test]
fn plain_register_dispatch_stays_unwired() {
    // register_dispatch 로 부팅하면 어떤 리포터에도 싱크가 설치되지 않는다 —
    // report 는 no-op(패닉 없음)이고 채널 수신은 0건이다.
    let reporter = HotSwapReporter::new();
    let app = tauri_support::register_dispatch(null_dispatch(), tauri::test::mock_builder())
        .build(mock_context(noop_assets()))
        .expect("mock app builds");
    let received = listen_on_swap_channel(&app);

    reporter.report(Ok(("old".into(), "new".into())));

    assert!(
        received.lock().unwrap().is_empty(),
        "plain register_dispatch must not wire swap reporting"
    );
}

#[test]
fn report_before_boot_is_a_noop() {
    // 부팅 전(싱크 미설치) 보고 — 패닉하지 않고 조용히 버려진다. 감시 스레드가
    // Tauri 부팅 완료를 기다릴 필요가 없다는 계약의 직접 증명.
    let reporter = HotSwapReporter::new();
    reporter.report(Err("early failure".into()));
    reporter.report(Ok(("old".into(), "new".into())));
}

/// 채널 리터럴과 접두사 조립의 정합 — EVENT_CHANNEL_PREFIX 재수출 경로로도
/// 같은 채널이 나온다는 것을 고정한다(event_push.rs 의 조립 방식과 동일).
#[test]
fn swap_channel_matches_prefix_composition() {
    assert_eq!(
        format!("{EVENT_CHANNEL_PREFIX}hot-core/swapped"),
        SWAP_CHANNEL
    );
}
