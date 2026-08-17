//! `Package::set_event_sink` 푸시 전달 경로의 공개 API 통합 테스트.
//!
//! 폴링(`take_pending_events`)과 푸시(싱크)가 상호 배타적으로 전환되는 계약을
//! `Package` 공개 API 레벨에서 증명한다:
//!
//! - 싱크 설치 → 싱크가 (name, payload) 를 그대로 수신, 버스는 비어 있음
//! - `set_event_sink(None)` → 폴링 폴백 복귀
//! - 싱크 패닉 → `emit` 정상 복귀 (호출자로 전파되지 않음)
//! - Package clone 간 싱크 공유 (`Arc` 내부 상태)
//! - 동일 스레드 연속 emit → 수신 순서 보존

use rustra::Package;
use std::sync::{Arc, Mutex};

type Seen = Arc<Mutex<Vec<(String, String)>>>;

fn recording_sink(seen: &Seen) -> rustra::events::EventSink {
    let seen = Arc::clone(seen);
    Arc::new(move |name: &str, payload: &str| {
        seen.lock()
            .unwrap()
            .push((name.to_string(), payload.to_string()));
    })
}

#[test]
fn emit_with_sink_bypasses_event_bus() {
    let pkg = Package::builder("test.sink").build();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    pkg.set_event_sink(Some(recording_sink(&seen)));

    pkg.emit("progress.tick", serde_json::json!({ "value": 42 }));

    let events = seen.lock().unwrap().clone();
    assert_eq!(events.len(), 1, "sink must receive the event");
    assert_eq!(events[0].0, "progress.tick");
    let payload: serde_json::Value = serde_json::from_str(&events[0].1).unwrap();
    assert_eq!(payload["value"], 42);
    assert!(
        pkg.event_bus().take_pending_events().is_empty(),
        "sink installed → bus must stay empty (no double delivery)"
    );
}

#[test]
fn clearing_sink_restores_polling_fallback() {
    let pkg = Package::builder("test.sink").build();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    pkg.set_event_sink(Some(recording_sink(&seen)));

    pkg.emit("a", serde_json::json!({ "n": 1 }));
    pkg.set_event_sink(None);
    pkg.emit("b", serde_json::json!({ "n": 2 }));

    assert_eq!(
        seen.lock().unwrap().len(),
        1,
        "only pre-clear emit hits the sink"
    );
    let polled = pkg.event_bus().take_pending_events();
    assert_eq!(polled.len(), 1, "post-clear emit must go to the bus");
    assert_eq!(polled[0].name, "b");
}

#[test]
fn polling_drop_oldest_still_works_without_sink() {
    // 싱크 없이 순수 폴링 경로 — 기존 drop-oldest 동작이 그대로인지 확인.
    // (버스 용량은 내부 고정 1024 이므로, 여기선 순서/seq 회귀만 검증한다.
    //  용량 초과 동작은 events.rs 유닛 테스트가 직접 다룬다.)
    let pkg = Package::builder("test.poll").build();
    for i in 0..8 {
        pkg.emit("tick", serde_json::json!({ "i": i }));
    }
    let events = pkg.event_bus().take_pending_events();
    assert_eq!(events.len(), 8);
    assert_eq!(events[0].seq, 0);
    assert_eq!(events[7].seq, 7);
    assert_eq!(events[0].name, "tick");
}

#[test]
fn panicking_sink_does_not_break_emit() {
    let pkg = Package::builder("test.panic").build();
    pkg.set_event_sink(Some(Arc::new(|_: &str, _: &str| {
        panic!("host sink exploded");
    })));

    // 패닉이 emit 호출자(커맨드 핸들러)로 전파되지 않아야 한다.
    pkg.emit("boom", serde_json::json!({ "n": 1 }));
    pkg.emit("boom", serde_json::json!({ "n": 2 }));

    // 싱크는 여전히 설치되어 있다 — 버스로 새지 않는다 (건너뛴 이벤트는 소실).
    assert!(pkg.event_bus().take_pending_events().is_empty());
}

#[test]
fn sink_is_shared_across_package_clones() {
    let pkg = Package::builder("test.shared").build();
    let clone = pkg.clone();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    clone.set_event_sink(Some(recording_sink(&seen)));

    // 원본에서 emit 해도 clone 이 설치한 싱크가 수신한다 (Arc 내부 상태 공유).
    pkg.emit("via-original", serde_json::json!({}));

    let events = seen.lock().unwrap().clone();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].0, "via-original");
    assert!(clone.event_bus().take_pending_events().is_empty());
}

#[test]
fn custom_event_capacity_and_dropped_stats_work() {
    let pkg = Package::builder("test.capacity").event_capacity(4).build();

    assert_eq!(pkg.event_bus().capacity(), 4);

    for i in 0..10 {
        pkg.emit("item", serde_json::json!({ "i": i }));
    }

    let (events, dropped) = pkg.event_bus().take_pending_events_with_stats();
    assert_eq!(events.len(), 4, "queue must hold at most capacity (4)");
    assert_eq!(dropped, 6, "10 emitted - 4 kept = 6 dropped");

    // Most recent 4 events kept (6, 7, 8, 9)
    let first_payload: serde_json::Value = serde_json::from_str(&events[0].payload).unwrap();
    assert_eq!(first_payload["i"], 6);
    let last_payload: serde_json::Value = serde_json::from_str(&events[3].payload).unwrap();
    assert_eq!(last_payload["i"], 9);
}

#[test]
fn sequential_emits_deliver_in_order() {
    let pkg = Package::builder("test.order").build();
    let seen: Seen = Arc::new(Mutex::new(Vec::new()));
    pkg.set_event_sink(Some(recording_sink(&seen)));

    for i in 0..5 {
        pkg.emit("tick", serde_json::json!({ "i": i }));
    }

    let events = seen.lock().unwrap().clone();
    let values: Vec<i64> = events
        .iter()
        .map(|(_, payload)| {
            serde_json::from_str::<serde_json::Value>(payload).unwrap()["i"]
                .as_i64()
                .unwrap()
        })
        .collect();
    assert_eq!(events.len(), 5);
    assert_eq!(
        values,
        vec![0, 1, 2, 3, 4],
        "single-threaded emits stay ordered"
    );
}

#[test]
fn sink_can_be_replaced() {
    let pkg = Package::builder("test.replace").build();
    let first: Seen = Arc::new(Mutex::new(Vec::new()));
    let second: Seen = Arc::new(Mutex::new(Vec::new()));
    pkg.set_event_sink(Some(recording_sink(&first)));
    pkg.emit("a", serde_json::json!({}));
    pkg.set_event_sink(Some(recording_sink(&second)));
    pkg.emit("b", serde_json::json!({}));

    assert_eq!(first.lock().unwrap().len(), 1);
    assert_eq!(second.lock().unwrap().len(), 1);
    assert_eq!(second.lock().unwrap()[0].0, "b");
}
