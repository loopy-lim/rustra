//! loop-stdio 런타임의 이벤트 푸시 프레임(예약 cmd id `0xfffd`) 계약 테스트.
//!
//! loop-stdio 는 example bin 이라 in-process 주입이 어려운 `main` 자체는
//! 두지 않고, bin 모듈이 노출하는 프레임 빌더(`encode_push_frame`)와 싱크
//! 설치 정책을 직접 검증한다:
//!
//! 1. 싱크 클로저가 프레임을 기록하면 `[len u32 LE][cmd u16 LE = 0xfffd]
//!    [1줄 JSON {"name","payload","seq"}]` 모양이 나온다(노드 디멀티플렉서와
//!    동일 와이어 — 트랙 D drain/demux 규약 확장).
//! 2. `push_enabled` 핸드셰이크 capability 로 싱크가 설치되면 emit 은 버스를
//!    우회한다 — 그 상태에서 drain(0xfffe)은 **빈 배열**을 반환하는 정상
//!    동작을 고정한다(푸시/폴링 이중 수신 방지, 코어 `deliver_via_sink` 계약).
//! 3. capability 없는(구 클라이언트) 핸드셰이크엔 싱크를 설치하지 않는다 —
//!    기존 폴링 사용자의 stdout 이 푸시 프레임으로 오염되지 않는다(무중단).

use rustra_calculator_example::loop_stdio::{
    PushDecision, encode_push_frame, handle_hello_with_policy,
};
use serde_json::Value;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// seq 발급기 — bin 모듈과 동일한 정책(0 시작 단조 증가)을 테스트도 쓴다.
fn seq_counter() -> Arc<AtomicU64> {
    Arc::new(AtomicU64::new(0))
}

#[test]
fn push_frame_encodes_header_and_json_body() {
    let frame = encode_push_frame("progress.tick", r#"{"step":1,"total":2}"#, 3);
    // [len u32 LE][cmd u16 LE = 0xfffd][json]
    let len = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    assert_eq!(frame.len(), 4 + len, "len covers cmd + body");
    assert_eq!(frame[4], 0xfd, "cmd id low byte (0xfffd LE)");
    assert_eq!(frame[5], 0xff, "cmd id high byte (0xfffd LE)");
    let parsed: Value = serde_json::from_slice(&frame[6..]).expect("frame body is 1-line JSON");
    assert_eq!(parsed["name"], "progress.tick");
    // payload 는 문자열 JSON 그대로 — Node 측에서 파싱 책임을 유지한다.
    assert_eq!(parsed["payload"], r#"{"step":1,"total":2}"#);
    assert_eq!(parsed["seq"], 3);
}

#[test]
fn sink_installation_bypasses_bus_and_drain_returns_empty() {
    // 프로세스 전역 캐시 패키지(calculator_package)를 쓰지 않는다 — 테스트가
    // 병렬 실행돼도 싱크 상태가 서로 간섭하지 않게 독립 Package 를 만든다.
    let package = rustra::Package::builder("test.push-events").build();
    let written: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    let sink_writes = Arc::clone(&written);
    let seq = seq_counter();
    let sink_seq = Arc::clone(&seq);
    package.set_event_sink(Some(Arc::new(move |name: &str, payload: &str| {
        let frame = encode_push_frame(name, payload, sink_seq.fetch_add(1, Ordering::Relaxed));
        sink_writes.lock().unwrap().extend_from_slice(&frame);
    })));

    package.emit(
        "progress.tick",
        serde_json::json!({ "step": 1, "total": 2 }),
    );

    // 버스 우회 — 푸시 모드에서 drain 이 빈 배열을 반환하는 정상 동작 고정.
    assert!(
        package.event_bus().take_pending_events().is_empty(),
        "emit must bypass the bus while a sink is installed"
    );

    let bytes = written.lock().unwrap().clone();
    assert!(!bytes.is_empty(), "sink must write 0xfffd frames");
    // 프레임 파싱: [len u32 LE][cmd u16 LE][json]
    let len = u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as usize;
    assert_eq!(bytes[4], 0xfd, "cmd id low byte (0xfffd LE)");
    assert_eq!(bytes[5], 0xff, "cmd id high byte (0xfffd LE)");
    assert_eq!(bytes.len(), 4 + len, "single frame, exact length");
    let parsed: Value = serde_json::from_slice(&bytes[6..]).expect("frame body is 1-line JSON");
    assert_eq!(parsed["name"], "progress.tick");
    assert_eq!(parsed["seq"], 0, "seq starts at 0");
    // payload 는 drain 페이로드와 동일 셰이프(객체)로 온다 — bin 의 drain 은
    // 객체로 넘기므로 싱크도 문자열 JSON 을 그대로 실어 Node 가 파싱한다.
    assert!(parsed["payload"].is_string());
    let payload: Value =
        serde_json::from_str(parsed["payload"].as_str().expect("payload is string JSON"))
            .expect("payload is valid JSON");
    assert_eq!(payload["step"], 1);

    // 싱크 해제 시 폴링 경로 즉시 복귀(코어 계약 — 회귀 가드).
    package.set_event_sink(None);
    package.emit("progress.tick", serde_json::json!({ "step": 2 }));
    assert_eq!(
        package.event_bus().take_pending_events().len(),
        1,
        "removing the sink restores the polling path"
    );
}

#[test]
fn hello_without_push_capability_keeps_polling_runtime() {
    // 구 클라이언트(`events` 요청 없음): 싱크 설치 없음 — stdout 오염 없음.
    // 독립 Package — 위 테스트와 병렬 실행돼도 싱크 상태를 공유하지 않는다.
    let package = rustra::Package::builder("test.hello-policy").build();
    let decision = handle_hello_with_policy(&package, false);
    assert_eq!(
        decision,
        PushDecision::PollOnly,
        "legacy handshake must not install the sink"
    );

    // push 요청: 싱크 설치 — emit 이 버스를 우회한다(stdout 기록은 bin main 의
    // 관심사라 여기선 검증하지 않는다 — 테스트 출력 오염 방지).
    let decision = handle_hello_with_policy(&package, true);
    assert_eq!(decision, PushDecision::Push);
    assert!(package.event_bus().take_pending_events().is_empty());
    package.set_event_sink(None);
    package.emit("tick", serde_json::json!({ "n": 1 }));
    assert_eq!(
        package.event_bus().take_pending_events().len(),
        1,
        "sink removal restores the bus"
    );
}
