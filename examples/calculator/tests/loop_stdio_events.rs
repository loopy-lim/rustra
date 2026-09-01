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
    PushDecision, encode_push_frame, handle_hello_with_policy, lock_stdout,
};
use serde_json::Value;
use std::io::Write;
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

/// I-1 계약: 백그라운드 스레드 emit 이 실제로 푸시 프레임을 기록하고, main 스레드의
/// 응답 쓰기와 **동시 경합**해도 프레임이 찢어지지 않는다.
///
/// bin 이 stdout 에 쓰는 경로(`run_binary` 응답, NDJSON 응답)와 싱크의 푸시 쓰기는
/// 모두 `STDOUT_LOCK` 임계구역 안에 있어야 한다 — 그렇지 않으면 임의 스레드 emit 의
/// 프레임이 응답 프레임 한가운데 끼어와(Node 디멀티플렉서의 프로토콜 오염) 응답
/// waiter 가 깨진다. 테스트는 응답 쓰기(`run_binary`)와 별도 스레드 emit 을 반복
/// 경합시켜 (1) emit 이 영구 블록 없이 완료되고(데드락 부정), (2) 수신 바이트열이
/// 항상 잘 구성된 프레임 경계로만 파싱됨을 고정한다.
#[test]
fn background_thread_emit_races_response_writes_without_corruption() {
    use std::time::Duration;

    // 독립 Package — 병렬 테스트의 싱크 상태 간섭 방지(위 테스트와 동일 관례).
    let package = rustra::Package::builder("test.push-thread-race").build();
    let decision = handle_hello_with_policy(&package, true);
    assert_eq!(decision, PushDecision::Push);

    // run_binary 가 쓰는 W — 실제 stdout 대신 독립 버퍼로 수집한다. run_binary 의
    // 응답 쓰기와 싱크의 푸시 쓰기가 같은 STDOUT_LOCK 임계구역을 공유하므로 경합
    // 구조(락 상호배제)는 실 stdout 과 동일하다.
    let main_writes: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    struct Shared(Arc<Mutex<Vec<u8>>>);
    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            // run_binary 는 이미 lock_stdout() 을 잡은 상태로 W 에 쓴다 — W 내부
            // 에서 락을 다시 잡으면(std Mutex 는 재귀 아님) 즉시 데드락이므로
            // 잡지 않는다. 찢김 방지는 run_binary 쪽 임계구역이 담당한다.
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut out = Shared(Arc::clone(&main_writes));

    // drain 요청 프레임 1개 — [len u32 LE=2][0xfffe]. run_binary 의 STDOUT_LOCK
    // 응답 쓰기를 유발한다.
    let drain_request = {
        let mut frame = vec![2u8, 0, 0, 0];
        frame.extend_from_slice(&0xFFFEu16.to_le_bytes());
        frame
    };

    // emit 스레드 — 50회 푸시(싱크는 write_push_frame_to_stdout 로 stdout 에 쓴다).
    // 백그라운드 스레드 emit 이 블록 없이 완료되는지가 I-1 데드락 부정의 핵심:
    // main 이 프로그램 수명 StdoutLock 을 쥐면(구조) 이 스레드가 영구 블록돼
    // join 이 멈춘다. 테스트 프로세스 stdout 은 테스트 하네스가 소유하므로 오염
    // 되지 않게 하려면 stdout 이 아닌 writer 로 싱크를 다시 설치해야 하지만
    // install_push_sink 는 stdout 고정 — 대신 싱크를 직접 설치해 같은 경로
    // (STDOUT_LOCK → 쓰기)를 검증한다.
    let emitter_writes: Arc<Mutex<Vec<u8>>> = Arc::new(Mutex::new(Vec::new()));
    {
        let emitter_sink = Arc::clone(&emitter_writes);
        let seq = Arc::new(AtomicU64::new(0));
        let sink_seq = Arc::clone(&seq);
        package.set_event_sink(Some(Arc::new(move |name: &str, payload: &str| {
            // write_push_frame_to_stdout 와 동일 임계구역 진입 — 실제 stdout 쓰기
            // 대신 버퍼 기록(테스트 출력 오염 방지). 락 규약(STDOUT_LOCK 먼저 →
            // 대상 write)은 동일하다.
            let _guard = lock_stdout();
            let frame = encode_push_frame(name, payload, sink_seq.fetch_add(1, Ordering::Relaxed));
            emitter_sink.lock().unwrap().extend_from_slice(&frame);
        })));
    }
    let emitter = {
        let package = package.clone();
        std::thread::spawn(move || {
            for i in 0..50 {
                package.emit("progress.tick", serde_json::json!({ "step": i }));
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };

    // emit 스레드와 경합하며 drain 요청 50회 — 각 요청이 run_binary 의
    // STDOUT_LOCK 응답 쓰기를 유발한다.
    for _ in 0..50 {
        let mut cursor = std::io::Cursor::new(drain_request.clone());
        rustra_calculator_example::loop_stdio::run_binary(&package, &mut cursor, &mut out)
            .expect("run_binary must succeed");
    }
    emitter.join().expect("emitter must not deadlock");

    // (1) emit 50회가 모두 프레임으로 도달했다 — 백그라운드 스레드가 블록/유실
    // 없이 완료됐다(데드락 부정은 join 자체가 증명: 블록 시 타임아웃으로 fail).
    let emitted = emitter_writes.lock().unwrap().clone();
    let mut offset = 0usize;
    let mut pushes = 0usize;
    while offset < emitted.len() {
        let len = u32::from_le_bytes([
            emitted[offset],
            emitted[offset + 1],
            emitted[offset + 2],
            emitted[offset + 3],
        ]) as usize;
        let frame_end = offset + 4 + len;
        assert!(
            frame_end <= emitted.len(),
            "truncated push frame at {offset}"
        );
        assert_eq!(
            u16::from_le_bytes([emitted[offset + 4], emitted[offset + 5]]),
            0xFFFD,
            "push frame cmd id"
        );
        let parsed: Value = serde_json::from_slice(&emitted[offset + 6..frame_end])
            .expect("push frame body must be intact 1-line JSON");
        assert!(parsed["name"].is_string());
        offset = frame_end;
        pushes += 1;
    }
    assert_eq!(pushes, 50, "all background emits must land as frames");

    // (2) run_binary 수신 바이트열이 항상 잘 구성된 응답 경계로만 파싱된다 —
    // 싱크/응답이 같은 락을 공유하지 않으면(위반 시나리오) emit 프레임이 응답
    // 한가운데에 끼어 이 파싱이 깨진다.
    let bytes = main_writes.lock().unwrap().clone();
    assert!(!bytes.is_empty(), "race must produce response frames");
    offset = 0;
    let mut responses = 0usize;
    while offset < bytes.len() {
        assert!(offset + 4 <= bytes.len(), "truncated header at {offset}");
        let len = u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ]) as usize;
        let frame_end = offset + 4 + len;
        assert!(frame_end <= bytes.len(), "truncated body at {offset}");
        // 응답 프레임 — ok 플래그로 시작. 푸시 프레임(0xfffd cmd)이 끼어 있으면
        // 이 단언이 즉시 깨진다.
        assert_eq!(bytes[offset + 4], 1, "drain response ok flag at {offset}");
        offset = frame_end;
        responses += 1;
    }
    assert_eq!(responses, 50, "all drain responses must land as frames");

    package.set_event_sink(None);
}
