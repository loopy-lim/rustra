//! Task 2 — Tauri 이벤트 푸시 배선(headless) 검증.
//!
//! `tauri::test::MockRuntime` 로 실제 Tauri 앱을 띄우지 않고(웹뷰/이벤트
//! 루프 없음) `register_with_events` 의 배선을 증명한다:
//!
//! 1. `register_with_events` 로 빌드하면 플러그인 setup 에서 싱크가 설치된다 —
//!    `Package::emit` 이 `app.emit("rustra://{name}", payload_json)` 로 도달한다.
//! 2. 페이로드는 JSON 문자열 그대로 전달된다(이중 직렬화 없음 — JS 에서
//!    `JSON.parse` 1회 복원).
//! 3. 싱크 설치 상태에서 버스는 우회된다(폴링과 이중 수신 없음).
//! 4. 기존 `register`(하위호환)는 싱크를 설치하지 않는다 — 폴링 경로 유지.
//! 5. 호스트가 나중에 자기 `.setup()` 을 붙여도 rustra 플러그인 setup 은
//!    덮어써지지 않는다(`tauri::Builder::setup` 단일 슬롯 문제 회피 증명).

use rustra::Package;
use rustra::prelude::*;
use rustra::tauri_support::{self, EVENT_CHANNEL_PREFIX};
use std::sync::{Arc, Mutex};
use tauri::Listener;
use tauri::test::{MockRuntime, mock_context, noop_assets};

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct EmitDemoInput {
    n: i64,
}
#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct EmitDemoOutput {
    accepted: bool,
}

/// emit 만 하는 테스트 전용 핸들러 — calculator_package(공유 아티팩트) 를
/// 건드리지 않기 위해 예제 로컬 패키지를 만든다.
fn emit_demo(_input: EmitDemoInput) -> rustra::Result<EmitDemoOutput> {
    Ok(EmitDemoOutput { accepted: true })
}

fn emit_demo_package() -> Package {
    Package::builder("example.event-push")
        .command("emitDemo", emit_demo)
        .build()
}

type Received = Arc<Mutex<Vec<String>>>;

fn build_app_with_listener(
    register: fn(Package, tauri::Builder<MockRuntime>) -> tauri::Builder<MockRuntime>,
) -> (tauri::App<MockRuntime>, Package, Received) {
    let pkg = emit_demo_package();
    let emit_pkg = pkg.clone();
    let builder = register(pkg, tauri::test::mock_builder());
    let app = builder
        .build(mock_context(noop_assets()))
        .expect("mock app builds");

    let received: Received = Arc::new(Mutex::new(Vec::new()));
    let sink_received = Arc::clone(&received);
    app.listen(
        format!("{EVENT_CHANNEL_PREFIX}progress_tick"),
        move |event| {
            sink_received
                .lock()
                .unwrap()
                .push(event.payload().to_string());
        },
    );
    (app, emit_pkg, received)
}

#[test]
fn register_with_events_delivers_emit_to_tauri_channel() {
    let (_app, pkg, received) = build_app_with_listener(tauri_support::register_with_events);

    pkg.emit("progress.tick", serde_json::json!({ "value": 42 }));

    let events = received.lock().unwrap().clone();
    assert_eq!(events.len(), 1, "listener must receive the pushed event");
    // 페이로드는 JSON 문자열 그대로 — 파싱하면 원본 객체.
    let payload: serde_json::Value = serde_json::from_str(&events[0]).unwrap();
    assert_eq!(payload["value"], 42);
    // 싱크 경로 → 버스 우회.
    assert!(pkg.event_bus().take_pending_events().is_empty());
}

#[test]
fn legacy_register_keeps_polling_path() {
    let (_app, pkg, received) = build_app_with_listener(tauri_support::register);

    pkg.emit("progress.tick", serde_json::json!({ "value": 7 }));

    assert!(
        received.lock().unwrap().is_empty(),
        "legacy register must not install a push sink"
    );
    let polled = pkg.event_bus().take_pending_events();
    assert_eq!(polled.len(), 1, "emit must land on the polling bus");
    assert_eq!(polled[0].name, "progress.tick");
}

#[test]
fn host_setup_hook_does_not_clobber_rustra_sink() {
    // 호스트가 register_with_events 이후 자기 .setup() 을 붙이는 일반적인 순서.
    let pkg = emit_demo_package();
    let emit_pkg = pkg.clone();
    let builder =
        tauri_support::register_with_events(pkg, tauri::test::mock_builder()).setup(|_app| Ok(()));
    let app = builder
        .build(mock_context(noop_assets()))
        .expect("mock app builds");

    let received: Received = Arc::new(Mutex::new(Vec::new()));
    let sink_received = Arc::clone(&received);
    app.listen(
        format!("{EVENT_CHANNEL_PREFIX}progress_tick"),
        move |event| {
            sink_received
                .lock()
                .unwrap()
                .push(event.payload().to_string());
        },
    );

    emit_pkg.emit("progress.tick", serde_json::json!({ "value": 1 }));

    assert_eq!(
        received.lock().unwrap().len(),
        1,
        "plugin-based sink must survive a later host .setup()"
    );
}

#[test]
fn sink_emits_from_background_thread() {
    // 스레드 계약: emit 을 호출한 스레드에서 싱크가 실행된다 — 백그라운드
    // 스레드의 emit 도 AppHandle::emit(내부적으로 스레드 안전) 으로 전달된다.
    let (_app, pkg, received) = build_app_with_listener(tauri_support::register_with_events);

    let worker = std::thread::spawn(move || {
        pkg.emit("progress.tick", serde_json::json!({ "value": 99 }));
    });
    worker.join().unwrap();

    assert_eq!(received.lock().unwrap().len(), 1);
}
