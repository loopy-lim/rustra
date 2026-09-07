//! loop-stdio 런타임의 채널 예약 cmd id(0xfffb 발급 / 0xfffa 해제 / 0xfffc 푸시)
//! 계약 테스트 — `@rustra/node` `createNodeChannel` 의 와이어 짝.
//!
//! 이벤트 푸시(0xfffd) 테스트(tests/loop_stdio_events.rs)와 동일 관례다:
//!
//! 1. `run_binary` 로 발급(0xfffb) 요청을 흘리면 `[ok=1][len][{"handle"}]`
//!    응답이 나오고, 발급 핸들로 `ChannelHandle::send` 한 페이로드가
//!    STDOUT_LOCK 임계구역을 거쳐 0xfffc 프레임으로 기록된다.
//! 2. 해제(0xfffa) 후 send 는 프레임을 남기지 않고(코어 `drop_channel` 계약),
//!    해제 응답 ok 플래그가 만료 핸들에 대해 0 이다(멱등성의 와이어 표현).
//! 3. 백그라운드 스레드 send(비동기 핸들러)와 run_binary 응답 쓰기가 경합해도
//!    프레임이 찢어지지 않는다 — sender 클로저가 STDOUT_LOCK 을 쓰기 때문
//!    (이벤트 싱크 I-1 계약과 동일). 이는 Bun FFI 브릿지의 threadsafe:false
//!    스레드 계약과 달리 Node 루프가 백그라운드 send 를 받을 수 있음을 증명한다.

use rustra_calculator_example::loop_stdio::{
    BINARY_CHANNEL_CREATE_CMD, BINARY_CHANNEL_DROP_CMD, BINARY_CHANNEL_PUSH_CMD, run_binary,
};
use serde_json::Value;
use std::io::{Cursor, Write};
use std::sync::{Arc, Mutex};

/// stdout 쓰기를 수집하는 W — run_binary 가 쓰는 응답과 채널 sender 가 쓰는
/// 0xfffc 프레임이 모두 여기 착지한다(실 stdout 대신 — 테스트 출력 오염 방지).
#[derive(Clone)]
struct SharedSink(Arc<Mutex<Vec<u8>>>);

impl Write for SharedSink {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        // run_binary 는 lock_stdout() 을 잡은 상태로 W 에 쓴다 — 여기서 락을
        // 다시 잡지 않는다(std Mutex 비재귀 — loop_stdio_events.rs 동일 주석).
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// 예약 cmd 요청 프레임 — [len u32 LE][cmd u16 LE][본문...].
fn request(cmd: u16, body: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + 2 + body.len());
    frame.extend_from_slice(&((2 + body.len()) as u32).to_le_bytes());
    frame.extend_from_slice(&cmd.to_le_bytes());
    frame.extend_from_slice(body);
    frame
}

/// postcard varint u32 인코딩 — drop 요청 본문용(코덱이 args.channel 을
/// 인코딩하는 것과 동일 LEB128).
fn encode_varint(mut value: u32) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let mut byte = (value % 128) as u8;
        value /= 128;
        if value > 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            return out;
        }
    }
}

/// 수집된 바이트열에서 프레임 경계로 파싱한다. 응답 프레임은 `[ok u8][pad 3]
/// [len u32][json]`(cmd id 로 시작하지 않는다 — ok 플래그), 채널 푸시 프레임은
/// `[cmd u16 LE = 0xfffc][json]`(cmd id 로 시작). 첫 u16 LE 로 두 형태를
/// 구분한다 — ok는 0/1이라 0xfffc 와 절대 충돌하지 않는 와이어 사실이 근거다
/// (loop_stdio.rs 디멀티플렉서 계약과 동일). 찢어진/끼어든 프레임이 있으면 이
/// 파싱이 즉시 깨진다(오염 감지기).
#[derive(Debug)]
enum WireFrame {
    /// 응답 — ok 플래그 + 본문(ok=0 면 본문 없음).
    Response { ok: u8, body: Vec<u8> },
    /// 채널 푸시 — cmd id(항상 0xfffc) + 1줄 JSON.
    ChannelPush {
        #[allow(dead_code)] // cmd/body 는 프레임 셰이프 테스트에서 개별 검증.
        cmd: u16,
        #[allow(dead_code)]
        body: Vec<u8>,
    },
}

fn parse_frames(bytes: &[u8]) -> Vec<WireFrame> {
    let mut frames = Vec::new();
    let mut offset = 0usize;
    while offset < bytes.len() {
        assert!(offset + 4 <= bytes.len(), "truncated header at {offset}");
        let len = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
        let frame_end = offset + 4 + len;
        assert!(frame_end <= bytes.len(), "truncated body at {offset}");
        let body = &bytes[offset + 4..frame_end];
        let first_u16 = u16::from_le_bytes([body[0], body[1]]);
        if first_u16 == BINARY_CHANNEL_PUSH_CMD {
            frames.push(WireFrame::ChannelPush {
                cmd: first_u16,
                body: body[2..].to_vec(),
            });
        } else {
            assert_eq!(body[1..4], [0u8, 0, 0], "response frame must be ok|pad(3)");
            frames.push(WireFrame::Response {
                ok: body[0],
                body: body[4..].to_vec(),
            });
        }
        offset = frame_end;
    }
    frames
}

/// 테스트가 사용할 채널 sender 의 출력을 run_binary 와 같은 싱크로 우회한다 —
/// issue_channel 이 만드는 sender 는 stdout 고정이라 여기선 같은 임계구역
/// (STDOUT_LOCK → 쓰기)을 거치는 sender 를 직접 등록해 동일 경로를 검증한다.
fn register_stdout_path_channel(sink: &SharedSink) -> u32 {
    let host = rustra::channels::host();
    let handle = host.reserve_handle();
    assert!(handle > 0, "valid handle");
    let writer = Arc::clone(&sink.0);
    let sender: rustra::channels::ChannelSender = Arc::new(move |payload: &str| {
        let frame =
            rustra_calculator_example::loop_stdio::encode_channel_push_frame(handle, payload);
        // STDOUT_LOCK 임계구역 진입 — bin sender(write_push_frame_to_stdout)와
        // 동일 규약. 락 없이 쓰면 응답 프레임 한가운데 끼어 이 테스트의 파싱이
        // 깨진다(위반 시나리오 감지기 역할도 겸한다).
        let _guard = rustra_calculator_example::loop_stdio::lock_stdout();
        writer.lock().unwrap().extend_from_slice(&frame);
    });
    host.register_channel_with_handle(handle, sender);
    handle
}

#[test]
fn channel_push_frame_encodes_header_handle_and_string_payload() {
    // issue_channel sender 가 쓰는 프레임의 셰이프 고정 — [len u32 LE]
    // [cmd u16 LE = 0xfffc][1줄 JSON {"handle","payload"}], payload 는 문자열
    // JSON(Node 측에서 파싱 — 이벤트 푸시 0xfffd 와 동일 셰이프 경계).
    let frame =
        rustra_calculator_example::loop_stdio::encode_channel_push_frame(7, r#"{"step":1}"#);
    let len = u32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
    assert_eq!(frame.len(), 4 + len, "len covers cmd + body");
    assert_eq!(frame[4], 0xfc, "cmd id low byte (0xfffc LE)");
    assert_eq!(frame[5], 0xff, "cmd id high byte (0xfffc LE)");
    let parsed: Value = serde_json::from_slice(&frame[6..]).expect("frame body is 1-line JSON");
    assert_eq!(parsed["handle"], 7);
    assert_eq!(parsed["payload"], r#"{"step":1}"#);
}

#[test]
fn channel_create_responds_with_handle_and_installs_sender() {
    let package = rustra::Package::builder("test.channel-create").build();
    let sink = SharedSink(Arc::new(Mutex::new(Vec::new())));
    let mut out = sink.clone();

    // 발급 요청 — 본문 없는 0xfffb.
    let mut cursor = Cursor::new(request(BINARY_CHANNEL_CREATE_CMD, &[]));
    run_binary(&package, &mut cursor, &mut out).expect("create succeeds");
    let frames = parse_frames(&sink.0.lock().unwrap().clone());
    let handle = match frames.first().expect("one response") {
        WireFrame::Response { ok, body } => {
            assert_eq!(*ok, 1, "create ok flag");
            // body 는 [len u32][json] — JSON 은 8바이트 오프셋부터.
            let json_len = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
            let issued: Value = serde_json::from_slice(&body[4..4 + json_len]).expect("JSON body");
            let handle = issued["handle"].as_u64().expect("handle field") as u32;
            assert!(handle > 0, "positive handle");
            handle
        }
        WireFrame::ChannelPush { .. } => panic!("create response must not be a push frame"),
    };

    // issue_channel 의 sender 는 stdout 고정(프로덕션 bin 경로)이라 테스트 싱크가
    // 아니라 테스트 출력으로 프레임이 흐른다. 여기선 sender 설치 자체(코어 테이블
    // 등록)를 검증하고, 프레임 셰이프/락 규약은 동일 임계구역을 거치는 sink 기반
    // sender 로 밑의 경합 테스트가 담당한다.
    assert!(
        rustra::channels::ChannelHandle(handle).send(r#"{"step":1}"#),
        "issued handle has a sender installed"
    );

    // 테이블 정리 — 다른 테스트와 핸들 상태를 공유하지 않게(전역 호스트).
    assert!(rustra::channels::host().drop_channel(handle));
    assert!(
        !rustra::channels::ChannelHandle(handle).send(r#"{"after":false}"#),
        "dropped handle has no sender"
    );
}

#[test]
fn channel_drop_stops_frames_and_reports_staleness() {
    let package = rustra::Package::builder("test.channel-drop").build();
    let sink = SharedSink(Arc::new(Mutex::new(Vec::new())));
    let mut out = sink.clone();
    let handle = register_stdout_path_channel(&sink);

    // 해제 요청 — 본문은 varint u32 핸들.
    let drop_request = request(BINARY_CHANNEL_DROP_CMD, &encode_varint(handle));
    let mut cursor = Cursor::new(drop_request);
    run_binary(&package, &mut cursor, &mut out).expect("drop succeeds");
    let responses = |frames: Vec<WireFrame>| -> Vec<u8> {
        frames
            .into_iter()
            .filter_map(|frame| match frame {
                WireFrame::Response { ok, .. } => Some(ok),
                WireFrame::ChannelPush { .. } => None,
            })
            .collect()
    };
    let oks = responses(parse_frames(&sink.0.lock().unwrap().clone()));
    assert_eq!(oks.last(), Some(&1), "drop of a live handle reports ok");

    // 이후 send 는 프레임을 남기지 않는다(코어 drop_channel 계약).
    assert!(!rustra::channels::ChannelHandle(handle).send(r#"{"late":true}"#));

    // 재해제는 ok=0 — 만료 핸들의 와이어 표현(JS close() 의 false 반환과 짝).
    let again = request(BINARY_CHANNEL_DROP_CMD, &encode_varint(handle));
    let mut cursor = Cursor::new(again);
    run_binary(&package, &mut cursor, &mut out).expect("second drop succeeds");
    let oks = responses(parse_frames(&sink.0.lock().unwrap().clone()));
    assert_eq!(oks.last(), Some(&0), "double drop reports staleness");
}

#[test]
fn background_thread_channel_send_races_responses_without_corruption() {
    use std::time::Duration;

    let package = rustra::Package::builder("test.channel-thread-race").build();
    let sink = SharedSink(Arc::new(Mutex::new(Vec::new())));
    let mut out = sink.clone();
    let handle = register_stdout_path_channel(&sink);

    // 백그라운드 스레드 send — 비동기 핸들러가 임의 스레드에서
    // ChannelHandle::send 하는 실동선. sender 는 STDOUT_LOCK 을 쓰므로
    // run_binary 의 응답 쓰기와 경합해도 프레임이 찢어지지 않는다.
    let emitter = {
        let sink = sink.clone();
        std::thread::spawn(move || {
            for i in 0..50u32 {
                let frame = rustra_calculator_example::loop_stdio::encode_channel_push_frame(
                    handle,
                    &serde_json::json!({ "tick": i }).to_string(),
                );
                let _guard = rustra_calculator_example::loop_stdio::lock_stdout();
                sink.0.lock().unwrap().extend_from_slice(&frame);
                drop(_guard);
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };

    // 경합 윈도우 동안 drain 요청 50회 — 각 요청이 STDOUT_LOCK 응답 쓰기를 유발.
    let drain_request = {
        let mut frame = vec![2u8, 0, 0, 0];
        frame.extend_from_slice(&0xFFFEu16.to_le_bytes());
        frame
    };
    for _ in 0..50 {
        let mut cursor = Cursor::new(drain_request.clone());
        run_binary(&package, &mut cursor, &mut out).expect("run_binary must succeed");
    }
    emitter.join().expect("emitter must not deadlock");

    // 전체 바이트열이 프레임 경계로만 파싱된다 — 채널 sender 가 락을 안 썼으면
    // (위반 시나리오) 0xfffc 프레임이 drain 응답 한가운데 끼어 여기서 깨진다.
    let bytes = sink.0.lock().unwrap().clone();
    let frames = parse_frames(&bytes);
    let pushes = frames
        .iter()
        .filter(|f| matches!(f, WireFrame::ChannelPush { .. }))
        .count();
    let drains = frames
        .iter()
        .filter(|f| matches!(f, WireFrame::Response { .. }))
        .count();
    assert_eq!(pushes, 50, "all background sends land as frames");
    assert_eq!(drains, 50, "all drain responses land as frames");

    // 테이블 정리.
    rustra::channels::host().drop_channel(handle);
}

#[test]
fn channel_create_varint_body_is_rejected_without_panic() {
    // 0xfffb 는 본문 없는 요청 — 본문이 와도 무시하고 발급한다(wire 관용).
    // 대신 잘린 varint 본문의 0xfffa 가 패닉 없이 ok=0 응답을 내는지 고정한다.
    let package = rustra::Package::builder("test.channel-malformed").build();
    let sink = SharedSink(Arc::new(Mutex::new(Vec::new())));
    let mut out = sink.clone();

    // 연속 비트가 켜진 채 끊긴 varint(잘림) — decode_postcard_u32 가 None.
    let malformed = request(BINARY_CHANNEL_DROP_CMD, &[0x80, 0x80]);
    let mut cursor = Cursor::new(malformed);
    run_binary(&package, &mut cursor, &mut out).expect("malformed body must not kill the loop");
    let ok = parse_frames(&sink.0.lock().unwrap().clone())
        .into_iter()
        .filter_map(|frame| match frame {
            WireFrame::Response { ok, .. } => Some(ok),
            WireFrame::ChannelPush { .. } => None,
        })
        .next_back()
        .expect("response for malformed drop");
    assert_eq!(ok, 0, "malformed varint body is rejected, not panicked");
}
