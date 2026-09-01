//! 루프형 stdio 런타임 코어 — bin 크레이트와 통합 테스트가 공유하는 프로토콜
//! 구현. 바이너리 모드 프레이밍(트랙 D)과 이벤트 푸시 프레임(0xfffd)을 담는다.
//!
//! ## 프로토콜 요약 (상세는 `loop-stdio` bin 문서 참조)
//!
//! - 요청: `[len u32 LE][cmd_id u16 LE + postcard 본문]`
//! - 응답: `[len u32 LE][[ok u8][pad 3B][len u32 LE][body]]`
//! - drain(0xfffe) / push(0xfffd) 는 예약 cmd id — id 부여 대상이 아니다.

use rustra::Package;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

/// 이벤트 drain 예약 커맨드 id (바이너리 모드). 자동 부여 id(등록 순서)와
/// 충돌하지 않는 u16 상한부다.
pub const BINARY_DRAIN_EVENTS_CMD: u16 = 0xFFFE;

/// 이벤트 **푸시** 프레임 예약 cmd id (바이너리 모드). 응답 프레임은 ok 플래그
/// 바이트(0/1)로 시작하므로 cmd id 로 시작하는 이 프레임과 절대 충돌하지
/// 않는다 — 수신자(Node 디멀티플렉서)는 첫 u16 LE 가 0xfffd 인지로 분기한다.
pub const BINARY_PUSH_EVENTS_CMD: u16 = 0xFFFD;

/// 핸드셰이크(`__hello`)의 이벤트 전달 모드 요청/응답 capability 필드값 —
/// `"push"` 를 보낸 클라이언트에게만 싱크를 설치한다.
pub const PUSH_CAPABILITY: &str = "push";

/// 핸드셰이크 이벤트 정책 결과.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushDecision {
    /// `events:"push"` 요청 — 싱크 설치됨. 이후 emit 은 푸시 프레임으로 직행.
    Push,
    /// 요청 없음(구 클라이언트) — 폴링 전용. stdout 은 오염되지 않는다.
    PollOnly,
}

/// 이벤트 푸시 프레임 1개를 조립한다 — `[len u32 LE][cmd u16 LE = 0xfffd]
/// [1줄 JSON {"name","payload","seq"}]`. `len`은 cmd+본문 길이(접두 제외)다.
/// 본문은 NDJSON drain 페이로드와 동일 셰이프로, payload 는 **문자열 JSON**
/// 이다(Node 측에서 파싱 책임 유지).
///
/// 실패(비 UTF-8 페이로드 등)는 `None` — 호출자는 프레임을 건너뛴다.
pub fn encode_push_frame(name: &str, payload: &str, seq: u64) -> Vec<u8> {
    let body = json!({ "name": name, "payload": payload, "seq": seq }).to_string();
    let len = 2 + body.len();
    let mut frame = Vec::with_capacity(4 + len);
    frame.extend_from_slice(&(len as u32).to_le_bytes());
    frame.extend_from_slice(&BINARY_PUSH_EVENTS_CMD.to_le_bytes());
    frame.extend_from_slice(body.as_bytes());
    frame
}

/// `__hello` 핸드셰이크의 이벤트 정책 — `events:"push"` 요청 시에만 싱크를
/// 설치하고 응답 JSON 에 `events:"push"` capability 를 에코한다. 설치에 성공하면
/// emit 은 버스를 우회하므로(코어 `deliver_via_sink` 계약) drain 은 빈 배열을
/// 반환한다 — 푸시/폴링 이중 수신이 구조적으로 불가능하다.
///
/// 싱크 클로저는 stdout 쓰기 뮤텍스만 잡고 `main` 스레드 자원을 재진입하지
/// 않는다 — emit 이 임의 백그라운드 스레드에서 불려도 안전하다.
pub fn handle_hello_with_policy(package: &Package, wants_push: bool) -> PushDecision {
    if !wants_push {
        return PushDecision::PollOnly;
    }
    install_push_sink(package, write_push_frame_to_stdout);
    PushDecision::Push
}

/// stdout 프레임 원자성 락 — 푸시 프레임, 바이너리 응답, NDJSON 응답 **모든**
/// stdout 쓰기가 공유하는 단일 임계구역. 쓰기+플러시가 한 구역에서 일어나 emit
/// 이 임의 백그라운드 스레드에서 불려도 프레임이 찢어지지 않는다.
///
/// # 획득 순서 규약 (데드락 방지 — 어디서든 역순 금지)
///
/// 반드시 이 락을 **먼저** 잡고 그 안에서 `stdout.lock()` 을 건다. 역순은 순환
/// 대기를 만든다: 호출자가 프로그램 수명 `StdoutLock` 을 쥔 채 이 락을 기다리는
/// 스레드와, 이 락을 쥔 싱크가 `stdout.lock()` 을 기다리면 서로 영구 블록된다.
/// 이를 위해 bin `main` 은 프로그램 수명 `StdoutLock` 을 쥐지 않는다 — 락은
/// 쓰기 시점에 임계구역 안에서만 건다.
static STDOUT_LOCK: Mutex<()> = Mutex::new(());

/// STDOUT_LOCK 을 잡는다 — 싱크 쓰기와 bin 응답/NDJSON 쓰기, 경합 테스트가
/// 같은 규약으로 진입하는 단일 진입점(포이즈닝 관용).
pub fn lock_stdout() -> MutexGuard<'static, ()> {
    STDOUT_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

fn write_push_frame_to_stdout(frame: &[u8]) {
    let _guard = lock_stdout();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = out
        .write_all(frame)
        .and_then(|_| out.flush())
        .inspect_err(|error| eprintln!("rustra: event push write failed: {error}"));
}

/// 푸시 싱크 설치 — `writer` 는 완성된 프레임 바이트를 전달 채널에 쓴다(bin 은
/// stdout, 테스트는 메모리 버퍼). emit 은 임의 스레드에서 일어나므로 `writer`는
/// `Send + Sync` 다.
fn install_push_sink(package: &Package, writer: fn(frame: &[u8])) {
    let seq = Arc::new(AtomicU64::new(0));
    package.set_event_sink(Some(Arc::new(move |name: &str, payload: &str| {
        let frame = encode_push_frame(name, payload, seq.fetch_add(1, Ordering::Relaxed));
        writer(&frame);
    })));
}

/// 핸드셰이크 응답 JSON — id 에코 + binary capability + 이벤트 모드.
pub fn hello_response(echo_id: Value, events_mode: Option<&str>) -> Value {
    let mut response = json!({
        "id": echo_id,
        "ok": true,
        "binary": true,
        "eventsCmdId": BINARY_DRAIN_EVENTS_CMD,
    });
    if let Some(mode) = events_mode {
        response["events"] = json!(mode);
    }
    response
}

/// 바이너리 모드 루프 — 4B len 프레임을 read_exact 으로 읽고 rkyv V2 로
/// 직결 dispatch 한다. 응답 복사를 줄이기 위해 재사용 출력 버퍼에
/// `invoke_rkyv_v2_into` 로 기록하고(플러시 전까지 유지), 초과 응답만
/// core 의 probe 캐시 경유 Vec 으로 받는다.
pub fn run_binary<R: Read, W: Write>(
    package: &Package,
    reader: &mut R,
    out: &mut W,
) -> rustra::Result<()> {
    let mut len_bytes = [0u8; 4];
    // 재사용 출력 버퍼 — 64KB. 초과 응답은 DirectResponse::Buffered 경로.
    let mut out_buffer: Vec<u8> = vec![0u8; 64 * 1024];
    loop {
        use std::io::ErrorKind;
        match reader.read_exact(&mut len_bytes) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(rustra::RustraError::internal(e.to_string())),
        }
        let len = u32::from_le_bytes(len_bytes) as usize;
        if len == 0 {
            continue;
        }
        let mut payload = vec![0u8; len];
        if let Err(e) = reader.read_exact(&mut payload) {
            return Err(rustra::RustraError::internal(e.to_string()));
        }

        let response: Vec<u8> = if len >= 2
            && u16::from_le_bytes([payload[0], payload[1]]) == BINARY_DRAIN_EVENTS_CMD
        {
            drain_events_binary(package)
        } else {
            match package.invoke_rkyv_v2_into(&payload, &mut out_buffer) {
                Ok(rustra::DirectResponse::Written(n)) => out_buffer[..n].to_vec(),
                Ok(rustra::DirectResponse::Buffered(bytes)) => bytes,
                Err(error) => rustra::encode_rkyv_v2_error(&error),
            }
        };

        // 응답 쓰기도 STDOUT_LOCK 임계구역 — 백그라운드 스레드 emit 의 푸시
        // 프레임이 응답 프레임 한가운데 끼어들어 찢지 못한다. invoke 자체는 이
        // 구역 밖(위)에서 끝나므로 동기 emit(같은 스레드)의 락 재진입은 없다
        // (std Mutex 는 재귀 아님 — 임계구역 안에서 emit 하지 않는 것이 규약).
        let guard = lock_stdout();
        let written = out
            .write_all(&(response.len() as u32).to_le_bytes())
            .and_then(|_| out.write_all(&response))
            .and_then(|_| out.flush());
        drop(guard);
        written.map_err(rustra::RustraError::internal)?;
    }
}

/// 바이너리 이벤트 drain — NDJSON `__drainEvents` 와 동일 페이로드를 JSON
/// 배열로 실어 보낸다(응답 프레임 [ok=1][pad][len][json]).
fn drain_events_binary(package: &Package) -> Vec<u8> {
    let events: Vec<Value> = package
        .event_bus()
        .take_pending_events()
        .into_iter()
        .map(|ev| {
            let payload: Value =
                serde_json::from_str(&ev.payload).unwrap_or(Value::String(ev.payload));
            json!({ "name": ev.name, "payload": payload })
        })
        .collect();
    let json = serde_json::to_vec(&events).unwrap_or_default();
    let mut frame = vec![0u8; 8 + json.len()];
    frame[0] = 1; // ok = true
    frame[4..8].copy_from_slice(&(json.len() as u32).to_le_bytes());
    frame[8..].copy_from_slice(&json);
    frame
}
