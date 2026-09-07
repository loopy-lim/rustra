//! Tauri 채널 어댑터(headless) 검증 — 발급자 배선 + 채널 푸시 도달.
//!
//! `create_channel_for` 가 reserve→insert 2단계(ffi_channel.rs 관용)로
//! AppHandle 캡처 sender를 `ChannelHost`에 등록하고, Rust
//! `ChannelHandle::send`가 `app.emit("rustra://channel/{handle}")` 로
//! 도달하는지 증명한다. `tauri::test::MockRuntime` 으로 웹뷰/이벤트 루프
//! 없이 실행한다(event_push.rs 패턴).
//!
//! JS 어댑터 계약(`packages/tauri` createChannel)과의 대응:
//! 1. 발급 — JS `invoke('rustra_channel_create')` ↔ 테스트는 본체 함수 직접 호출
//! 2. 수신 — JS `listen('rustra://channel/{handle}')` ↔ 테스트는 같은 규칙으로 listen
//! 3. 왕복 — JS 어댑터 핸들을 `channelDemo` 인자로 통과 ↔ `invoke_json` 동일 경로

use rustra::channels;
use rustra::prelude::*;
use rustra::tauri_support::{self, CHANNEL_EVENT_PREFIX};
use std::sync::{Arc, Mutex};
use tauri::Listener;
use tauri::test::{MockRuntime, mock_builder, mock_context, noop_assets};

type Received = Arc<Mutex<Vec<String>>>;

fn build_app() -> (tauri::App<MockRuntime>, Received) {
    let package = Package::builder("example.channel-push").build();
    let builder = tauri_support::register_with_events(package, mock_builder());
    let app = builder
        .build(mock_context(noop_assets()))
        .expect("mock app builds");
    (app, Arc::new(Mutex::new(Vec::new())))
}

fn listen_on_channel(app: &tauri::App<MockRuntime>, handle: u32) -> Received {
    let received: Received = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&received);
    app.listen(format!("{CHANNEL_EVENT_PREFIX}{handle}"), move |event| {
        sink.lock().unwrap().push(event.payload().to_string());
    });
    received
}

#[test]
fn channel_create_returns_monotonic_nonzero_handle() {
    let (app, _received) = build_app();

    let first = tauri_support::create_channel_for(app.handle());
    let second = tauri_support::create_channel_for(app.handle());

    assert!(first > 0, "valid handle");
    assert!(second > first, "handles are monotonic");
}

#[test]
fn channel_send_reaches_channel_listener() {
    let (app, _received) = build_app();
    let handle = tauri_support::create_channel_for(app.handle());
    let received = listen_on_channel(&app, handle);

    let channel = channels::ChannelHandle(handle);
    assert!(channel.send(r#"{"step":1}"#), "fresh handle delivers");
    assert!(channel.send(r#"{"step":2}"#), "second send delivers");

    let events = received.lock().unwrap().clone();
    assert_eq!(events.len(), 2, "both frames reach the listener");
    let payload: serde_json::Value = serde_json::from_str(&events[0]).unwrap();
    assert_eq!(payload["step"], 1);
}

#[test]
fn channel_send_is_handle_scoped() {
    // 다른 핸들 리스너는 남의 프레임을 못 본다(채널명 분리).
    let (app, _received) = build_app();
    let mine = tauri_support::create_channel_for(app.handle());
    let other = tauri_support::create_channel_for(app.handle());
    let mine_received = listen_on_channel(&app, mine);
    let other_received = listen_on_channel(&app, other);

    channels::ChannelHandle(mine).send(r#"{"who":"mine"}"#);

    assert_eq!(mine_received.lock().unwrap().len(), 1);
    assert!(
        other_received.lock().unwrap().is_empty(),
        "frames must not leak across channel handles"
    );
}

#[test]
fn channel_drop_stops_delivery() {
    let (app, _received) = build_app();
    let handle = tauri_support::create_channel_for(app.handle());
    let received = listen_on_channel(&app, handle);

    assert!(channels::ChannelHandle(handle).send(r#"{"v":1}"#));
    assert!(
        tauri_support::drop_channel_for(app.handle(), handle),
        "drop of a live handle succeeds"
    );
    assert!(
        !channels::ChannelHandle(handle).send(r#"{"v":2}"#),
        "send after drop is a no-op returning false"
    );
    assert_eq!(received.lock().unwrap().len(), 1, "only the pre-drop frame");
    assert!(
        !tauri_support::drop_channel_for(app.handle(), handle),
        "double drop returns false"
    );
}

/// E2E — JS 어댑터가 발급한 핸들을 커맨드 인자로 통과하는 실동선.
/// channelDemo 가 채널로 ticks 번 send 하고 sent/droppedSends 를 보고한다.
#[test]
fn channel_demo_round_trip_through_issued_handle() {
    let (app, _received) = build_app();
    let handle = tauri_support::create_channel_for(app.handle());
    let received = listen_on_channel(&app, handle);

    // calculator 예제의 channel_demo 재현 — Package::builder 로 최소 패키지를
    // 만들어 invoke_json 경로를 통과시킨다(State 없는 헤드리스).
    let package = channel_demo_package();
    let result = package
        .invoke_json(
            "channelDemo",
            serde_json::json!({ "channel": handle, "ticks": 3 }),
        )
        .expect("channelDemo succeeds");
    assert_eq!(result["sent"], 3);
    assert_eq!(result["droppedSends"], 0);
    assert_eq!(received.lock().unwrap().len(), 3, "all ticks arrive");
}

fn channel_demo_package() -> Package {
    #[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    #[serde(rename_all = "camelCase")]
    struct ChannelDemoInput {
        channel: rustra::channels::ChannelHandle,
        ticks: i32,
    }
    #[derive(Debug, serde::Serialize, serde::Deserialize, schemars::JsonSchema)]
    #[serde(rename_all = "camelCase")]
    struct ChannelDemoOutput {
        sent: i32,
        dropped_sends: i32,
    }
    Package::builder("example.channel-demo")
        .command(
            "channelDemo",
            |input: ChannelDemoInput| -> rustra::Result<ChannelDemoOutput> {
                let mut sent = 0;
                let mut dropped = 0;
                for step in 0..input.ticks.max(0) {
                    let payload = serde_json::json!({ "step": step + 1, "of": input.ticks });
                    if input.channel.send(&payload.to_string()) {
                        sent += 1;
                    } else {
                        dropped += 1;
                    }
                }
                Ok(ChannelDemoOutput {
                    sent,
                    dropped_sends: dropped,
                })
            },
        )
        .build()
}
