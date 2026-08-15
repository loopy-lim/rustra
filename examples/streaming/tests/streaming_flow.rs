//! streaming 예제 통합 테스트 — 실제 이벤트 왕복 증명.

use rustra_streaming_example::{StartJobInput, event_bus, streaming_package};
use std::sync::Mutex;

/// 전역 이벤트 버스를 테스트 간 공유하므로 직렬화한다 — 병렬 실행 시 서로의
/// 이벤트를 가져가는 경합을 방지.
static TEST_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn job_emits_progress_and_done_events() {
    let _guard = TEST_LOCK.lock().unwrap();
    let package = streaming_package();
    let out: rustra::prelude::Result<rustra_streaming_example::StartJobOutput> = package.invoke(
        "startJob",
        StartJobInput {
            job_id: String::from("t-1"),
            total_steps: 5,
            step_delay_ms: 0,
        },
    );
    assert!(out.unwrap().accepted);

    // 백그라운드 스레드가 이벤트를 채울 때까지 대기 후 드레인.
    let bus = event_bus();
    let mut events = Vec::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        events.extend(bus.take_pending_events());
        if events.iter().any(|e| e.name == "job.done") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    let ticks = events.iter().filter(|e| e.name == "progress.tick").count();
    assert_eq!(ticks, 5, "expected 5 progress ticks, got {ticks}");
    assert!(
        events.iter().any(|e| e.name == "job.done"),
        "job.done missing: {events:?}"
    );

    // seq 단조성.
    let seqs: Vec<u64> = events.iter().map(|e| e.seq).collect();
    let mut sorted = seqs.clone();
    sorted.sort();
    assert_eq!(seqs, sorted, "events must arrive in seq order");
}

#[test]
fn event_payloads_carry_typed_json() {
    let _guard = TEST_LOCK.lock().unwrap();
    // 직전 테스트가 남긴 잔여 이벤트 정리.
    let _ = event_bus().take_pending_events();

    let package = streaming_package();
    let _: rustra::prelude::Result<rustra_streaming_example::StartJobOutput> = package.invoke(
        "startJob",
        StartJobInput {
            job_id: String::from("t-2"),
            total_steps: 2,
            step_delay_ms: 0,
        },
    );

    let bus = event_bus();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let mut events = Vec::new();
    while std::time::Instant::now() < deadline {
        events.extend(bus.take_pending_events());
        if events.iter().any(|e| e.name == "job.done") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    let first_tick = events
        .iter()
        .find(|e| e.name == "progress.tick")
        .expect("at least one tick");
    let payload: serde_json::Value = serde_json::from_str(&first_tick.payload).unwrap();
    assert_eq!(payload["jobId"], "t-2");
    assert_eq!(payload["total"], 2);
    assert!(payload["step"].is_number());
}
