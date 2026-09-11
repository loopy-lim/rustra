//! 루프형 stdio 런타임 — persistent 프로세스로 rustra 명령을 NDJSON 라인
//! 프레이밍으로 처리한다.
//!
//! `createNodeProcessTransport`(lazy-respawn, 호출마다 프로세스 재시작)의
//! 전제였던 "요청 하나만 읽고 종료" 대신, 이 런타임은 stdin 이 닫힐 때까지
//! 라인 단위로 요청을 읽어 응답을 한 줄씩 쓴다. `@rustra/node` 의
//! `createNodeLoopTransport` 가 이 바이너리와 짝을 이룬다.
//!
//! 프로토콜 (요청/응답 모두 한 줄 JSON):
//!
//! ```text
//! → {"id":1,"command":"addNumbers","args":{"a":20,"b":22}}
//! ← {"id":1,"ok":true,"result":{"value":42}}
//! ← {"id":2,"ok":false,"error":"command.not_found: ..."}
//! ```
//!
//! # 바이너리 모드 (옵트인 — 트랙 D)
//!
//! 첫 줄로 `{"id":0,"command":"__hello"}` 핸드셰이크를 보내면 런타임이 바이너리
//! 프레이밍으로 전환한다(`"binary":true` capability 로 응답). 전환 후 프레임은:
//!
//! ```text
//! 요청  [len: u32 LE][Frame 요청 프레임: cmd_id u16 LE + postcard 본문]
//! 응답  [len: u32 LE][Frame 응답 프레임: [ok u8][pad 3B][len u32 LE][body]]
//! ```
//!
//! `len`은 항상 프레임 본문 길이(접두 제외)다. 응답은 호출 순서대로
//! 1:1 대응된다(파이프라이닝 없음 — transport 계약). 커맨드 id `0xFFFE`는
//! 이벤트 drain 예약으로, 응답 본문에 대기 이벤트의 JSON 배열을 실는다.
//! 기존 NDJSON 소비자는 핸드셰이크를 보내지 않으면 계속 라인 프로토콜을
//! 그대로 쓴다(무중단 호환).
//!
//! # 이벤트 푸시 (옵트인 — 핸드셰이크 `events:"push"`)
//!
//! 핸드셰이크에 `"events":"push"` 를 함께 보내면 런타임이
//! `Package::set_event_sink` 로 푸시 싱크를 설치한다(`"events":"push"`
//! capability 로 응답). 이후 Rust `emit` 은 버스를 우회해 즉시 stdout 으로
//! 프레임을 쓴다:
//!
//! ```text
//! 푸시  [len: u32 LE][cmd u16 LE = 0xFFFD][1줄 JSON {"name","payload","seq"}]
//! ```
//!
//! `payload` 는 문자열 JSON(NDJSON drain 페이로드와 동일 셰이프 — Node 측에서
//! 파싱). `seq` 는 런타임별 0 시작 단조 증가. 응답 프레임은 ok 플래그 바이트로
//! 시작하고 푸시 프레임은 cmd id 로 시작하므로 수신자가 안전하게 분기한다.
//! 싱크 설치 중엔 drain(0xFFFE)이 항상 빈 배열을 반환한다(버스 우회 — 푸시+
//! 폴링 이중 수신 방지 코어 계약). 구 클라이언트(`events` 요청 없음)는 싱크가
//! 설치되지 않아 stdout 이 절대 오염되지 않는다 — 기존 폴링 사용자 무영향.
//!
//! # 바이너리 채널 (0xfff9 푸시 + 0xfffb 모드 플래그)
//!
//! 채널의 바이트 경로(코어 `ChannelHandle::send_bytes`). 푸시 프레임은 JSON
//! 채널(0xfffc)과 같은 "cmd id 로 시작하는 프레임" 와이어를 쓰되 본문이 JSON
//! 이 아니다:
//!
//! ```text
//! 푸시  [len: u32 LE][cmd: u16 LE = 0xFFF9][handle: u32 LE][payload bytes]
//! ```
//!
//! 페이로드는 Frame 프레임 등 임의 바이트를 그대로 실으며 길이 접두가 없다
//! — 프레임 래퍼의 `len` 이 이미 경계를 제공한다. 발급(0xfffb)은 기존 프레임을
//! 재사용하되 본문에 1바이트 모드 플래그를 추가한다: 본문 없음(또는 `0x00`)은
//! JSON 경로(기존과 바이트 동일), `0x01` 은 바이트 경로, 그 외 값은 ok=0 으로
//! 되돌린다(알 수 없는 미래 모드의 조용한 JSON 폴백 방지). 응답 셰이프는 JSON
//! 발급과 동일하다(`{"handle": u32}`). 해제(0xfffa)는 두 경로를 같이 내리는
//! 코어 `drop_channel` 을 그대로 쓴다 — 별도 확장 없음.
//!
//! 호환: 구 클라이언트는 모드 바이트를 보내지 않으므로 JSON 경로가 그대로
//! 동작하고(양방향), 구 런타임에 모드 `0x01` 을 보내는 경우를 대비해 `__hello`
//! 응답에 `"channelBytes": true` capability 를 에코한다 — 미수용 런타임에서 새
//! 클라이언트의 `createNodeBytesChannel` 은 프레임을 보내기 전에
//! `channel.unavailable` 로 loud-fail 한다(조용한 경로 불일치 방지). 구
//! 클라이언트는 알 수 없는 필드를 무시한다(binary/events 와 동일 규약).
//!
//! 프로토콜 구현 본체는 `rustra_calculator_example::loop_stdio` 모듈 — 통합
//! 테스트(`tests/loop_stdio_events.rs`)가 같은 모듈을 직접 검증한다. 바이트
//! 채널 발급 가로채기(모드 플래그 분기)만 이 bin 이 소유한다.

use rustra_calculator_example::calculator_package;
use rustra_calculator_example::loop_stdio::{
    BINARY_CHANNEL_CREATE_CMD, PUSH_CAPABILITY, handle_hello_with_policy, hello_response,
    lock_stdout, run_binary,
};
use serde_json::{Value, json};
use std::io::{BufRead, ErrorKind, Read, Write};
use std::sync::Arc;

/// 채널 **바이너리 푸시** 프레임 예약 cmd id. JSON 채널 푸시(0xfffc)와 동일한
/// "cmd id 로 시작하는 프레임" 와이어를 쓰되 본문은 `[handle u32 LE][payload
/// bytes]` — 문자열 JSON 래핑 없이 바이트 그대로다. 응답 프레임은 ok 플래그
/// 바이트(0/1)로 시작하므로 첫 u16 LE 충돌이 없다(0xfffd/0xfffc 과 동일 근거).
const BINARY_CHANNEL_PUSH_BYTES_CMD: u16 = 0xFFF9;

/// 0xfffb 발급 본문의 모드 플래그 — `0x00`/본문 없음 = JSON 경로, `0x01` =
/// 바이트 경로. 그 외 값은 ok=0 (unknown mode loud-fail).
const CHANNEL_CREATE_MODE_JSON: u8 = 0x00;
const CHANNEL_CREATE_MODE_BYTES: u8 = 0x01;

fn main() -> rustra::Result<()> {
    let package = calculator_package();
    let stdin = std::io::stdin();
    let mut reader = stdin.lock();

    let mut line = String::new();
    loop {
        line.clear();
        let read = reader
            .read_line(&mut line)
            .map_err(rustra::RustraError::internal)?;
        if read == 0 {
            return Ok(()); // stdin EOF
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        // 라인당 JSON 파싱 1회 — 핸드셰이크 판별과 id/events 요청 추출이 같은 파스를 쓴다.
        let request: Option<Value> = serde_json::from_str(trimmed).ok();
        let is_hello = request
            .as_ref()
            .and_then(|v| v.get("command").and_then(Value::as_str))
            == Some("__hello");
        if is_hello {
            // id 에코 — 요청의 id 를 그대로 돌려준다(transport 상관 유지).
            let echo_id = request
                .as_ref()
                .and_then(|v| v.get("id").cloned())
                .unwrap_or(Value::Null);
            // events:"push" 요청 시에만 싱크를 설치한다 — 푸시는 엄선된 옵트인.
            // 요청이 없으면(구 클라이언트) 폴링 전용으로 응답하고 stdout 은 오염되지
            // 않는다. 기존 drain 지원이 플래그 없이 항상 제공되듯, push 도 NDJSON/
            // 바이너리 모드 협상과 같은 핸드셰이크 capability 로 옵트인한다.
            let wants_push = request
                .as_ref()
                .and_then(|v| v.get("events").and_then(Value::as_str))
                == Some(PUSH_CAPABILITY);
            let events_mode = if wants_push {
                match handle_hello_with_policy(&package, true) {
                    rustra_calculator_example::loop_stdio::PushDecision::Push => {
                        Some(PUSH_CAPABILITY)
                    }
                    rustra_calculator_example::loop_stdio::PushDecision::PollOnly => None,
                }
            } else {
                // 암묵적 폴링 전용 — 응답에 events 필드를 두지 않는다(구 클라이언트
                // 파서 오염 방지, 기존 응답과 바이트 호환 유지).
                None
            };
            let mut response = hello_response(echo_id, events_mode);
            // 바이너리 채널 capability — binary/events 와 동일한 핸드셰이크
            // capability 스타일. 구 클라이언트는 알 수 없는 필드를 무시하므로
            // 기존 응답 소비자 무영향이고, 새 클라이언트는 이 에코가 있을 때만
            // 바이트 채널을 만든다(구 런타임 = loud-fail, 아래 모듈 문서 참조).
            response["channelBytes"] = json!(true);
            let mut encoded =
                serde_json::to_vec(&response).map_err(rustra::RustraError::internal)?;
            encoded.push(b'\n');
            // stdout 획득 순서 규약(loop_stdio::STDOUT_LOCK 문서): 락 먼저,
            // 그 안에서 stdout.lock(). 프로그램 수명 StdoutLock 을 쥐지 않는다 —
            // 쥐면 백그라운드 스레드 emit(싱크)이 stdout.lock() 에서 영구 블록된다.
            let guard = lock_stdout();
            let mut stdout = std::io::stdout();
            {
                let mut out = stdout.lock();
                out.write_all(&encoded)
                    .map_err(rustra::RustraError::internal)?;
                out.flush().map_err(rustra::RustraError::internal)?;
            }
            drop(guard);
            // 0xfffb 모드 플래그 가로채기 리더로 감싼다 — 바이트 채널 발급만 이
            // bin 이 소비하고 나머지 프레임은 모듈 run_binary 에 바이트 그대로.
            let mut interceptor = BytesChannelCreateReader::new(reader);
            return run_binary(&package, &mut interceptor, &mut stdout);
        }
        let response = handle_line(&package, trimmed);
        let mut encoded = serde_json::to_vec(&response).map_err(rustra::RustraError::internal)?;
        encoded.push(b'\n');
        // NDJSON 응답 쓰기도 같은 규약 — 푸시 프레임이 응답 한가운데 끼지 못한다.
        let guard = lock_stdout();
        let stdout = std::io::stdout();
        let mut out = stdout.lock();
        out.write_all(&encoded)
            .map_err(rustra::RustraError::internal)?;
        // 라인 단위 flush — 호출자가 파이프에서 라인을 기다린다.
        out.flush().map_err(rustra::RustraError::internal)?;
        drop(out);
        drop(guard);
    }
}

fn handle_line(package: &rustra::Package, line: &str) -> Value {
    let request: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => {
            return json!({
                "id": Value::Null,
                "ok": false,
                "error": format!("command.invalid_args: json decode failed: {e}"),
            });
        }
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let command = match request.get("command").and_then(Value::as_str) {
        Some(c) => c.to_string(),
        None => {
            return json!({
                "id": id,
                "ok": false,
                "error": "command.invalid_args: missing command",
            });
        }
    };

    // 특수 명령: 이벤트 drain (폴링).
    if command == "__drainEvents" {
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
        return json!({ "id": id, "ok": true, "events": events });
    }

    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    match package.invoke_json(&command, args) {
        Ok(result) => json!({ "id": id, "ok": true, "result": result }),
        Err(e) => json!({ "id": id, "ok": false, "error": e.to_string() }),
    }
}

// ── 바이너리 채널 (0xfff9 푸시 + 0xfffb 모드 플래그) ──────────────────────

/// 바이너리 채널 푸시 프레임 1개를 조립한다 — `[len u32 LE][cmd u16 LE = 0xfff9]
/// [handle u32 LE][payload bytes]`. `len`은 cmd+핸들+페이로드 길이(접두 제외)다.
/// 페이로드 길이 접두는 없다 — 프레임 래퍼의 `len` 이 경계를 제공한다(0xfffc 의
/// JSON 본문과 달리 내부에 다른 경계면이 없으므로 접두가 중복되지 않는다).
fn encode_channel_bytes_push_frame(handle: u32, payload: &[u8]) -> Vec<u8> {
    let len = 2 + 4 + payload.len();
    let mut frame = Vec::with_capacity(4 + len);
    frame.extend_from_slice(&(len as u32).to_le_bytes());
    frame.extend_from_slice(&BINARY_CHANNEL_PUSH_BYTES_CMD.to_le_bytes());
    frame.extend_from_slice(&handle.to_le_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// 완성된 프레임(접두 포함)을 STDOUT_LOCK 임계구역에서 stdout 으로 쓴다 —
/// 모듈 `write_push_frame_to_stdout` 과 동일 규약이지만 bin 이 소유한다(모듈
/// 함수는 비공개). 응답 쓰기(run_binary 의 `out`)와 같은 임계구역을 공유하므로
/// 백그라운드 스레드 send 와 응답이 경합해도 프레임이 찢어지지 않는다.
fn write_frame_to_stdout(frame: &[u8]) {
    let guard = lock_stdout();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let _ = out
        .write_all(frame)
        .and_then(|_| out.flush())
        .inspect_err(|error| eprintln!("rustra: bytes channel write failed: {error}"));
    drop(out);
    drop(guard);
}

/// 완성된 응답 본문에 프레임 접두(len u32 LE)를 붙인다.
fn frame_with(body: Vec<u8>) -> Vec<u8> {
    let mut frame = (body.len() as u32).to_le_bytes().to_vec();
    frame.extend(body);
    frame
}

/// 바이너리 채널을 발급한다 — 코어 전역 `ChannelHost` bytes 테이블에 0xfff9
/// 프레임 sender 를 등록하고 핸들을 반환한다(JSON `issue_channel` 과 동일한
/// 선점→등록 2단계, 동일 단조 핸들 공간). sender 클로저는 STDOUT_LOCK 안에서
/// 쓰므로 임의 스레드의 `ChannelHandle::send_bytes` 가 안전하다.
///
/// 핸들 공간 소진 시 0 — ok=0 응답으로 되돌리고 JS 어댑터가 loud-fail 한다.
fn issue_bytes_channel() -> u32 {
    let host = rustra::channels::host();
    let handle = host.reserve_handle();
    if handle == 0 {
        return 0;
    }
    let sender: rustra::channels::ChannelBytesSender = Arc::new(move |payload: &[u8]| {
        let frame = encode_channel_bytes_push_frame(handle, payload);
        write_frame_to_stdout(&frame);
    });
    host.register_channel_bytes_with_handle(handle, sender);
    handle
}

/// 바이너리 채널 발급 응답 프레임(접두 포함 완성 바이트) — JSON 발급
/// (`loop_stdio::channel_create_response`)과 동일 셰이프
/// `[ok=1][pad 3][len u32][{"handle": u32}]`. 핸들 소진(0)은 ok=0(본문 없음).
fn bytes_channel_create_response(handle: u32) -> Vec<u8> {
    if handle == 0 {
        return frame_with(vec![0u8; 8]);
    }
    let body = json!({ "handle": handle }).to_string();
    let mut response = vec![0u8; 8 + body.len()];
    response[0] = 1; // ok = true
    response[4..8].copy_from_slice(&(body.len() as u32).to_le_bytes());
    response[8..].copy_from_slice(body.as_bytes());
    frame_with(response)
}

/// 0xfffb 발급 프레임의 모드 플래그를 가로채는 프레임 단위 리더.
///
/// 모듈 `run_binary`(공유 소유 — 수정 불가)은 본문 없는 0xfffb 만 JSON 채널로
/// 발급한다. 이 리더가 stdin 을 프레임 단위로 미리 읽어 모드 `0x01` 발급을
/// 소비하고 응답을 직접 쓰면(STDOUT_LOCK 규약 준수) `run_binary` 은 그 프레임을
/// 못 본다. 그 외 모든 프레임 — legacy JSON 발급(len=2, 바이트 동일), 해제
/// (0xfffa, 코어 `drop_channel` 이 두 테이블을 함께 내림), drain, 일반 invoke —
/// 는 바이트 그대로 통과시켜 모듈 경로가 처리한다(무중단 호환의 핵심).
///
/// EOF/절단 프레임의 의미는 `run_binary` 자신의 계약과 동일하게 유지된다: 헤더
/// 지점의 EOF 는 깨끗한 스트림 종료(Ok(0))로, 본문 도중 EOF 는 그대로 전파된다.
struct BytesChannelCreateReader<R: Read> {
    inner: R,
    /// 통과 대기 바이트 — 프레임 1개 이하(run_binary 의 read_exact 호출 크기와
    /// 정확히 정렬된다: 4바이트 헤더, 이어서 len 바이트 본문).
    pending: Vec<u8>,
    done: bool,
}

impl<R: Read> BytesChannelCreateReader<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            pending: Vec::new(),
            done: false,
        }
    }

    /// 프레임 1개를 읽는다 — 모드 `0x01`/알 수 없는 모드 발급은 소비(응답 직접
    /// 기록)하고, 나머지는 `pending` 으로 통과시킨다.
    fn fill_one_frame(&mut self) -> std::io::Result<()> {
        let mut len_bytes = [0u8; 4];
        match self.inner.read_exact(&mut len_bytes) {
            Ok(()) => {}
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => {
                self.done = true;
                return Ok(());
            }
            Err(e) => return Err(e),
        }
        let len = u32::from_le_bytes(len_bytes) as usize;
        if len == 0 {
            // run_binary 은 len=0 프레임을 본문 없이 continue 처리한다 — 4바이트만
            // 통과시킨다.
            self.pending.extend_from_slice(&len_bytes);
            return Ok(());
        }
        let mut body = vec![0u8; len];
        self.inner.read_exact(&mut body)?;
        let is_create =
            len >= 3 && u16::from_le_bytes([body[0], body[1]]) == BINARY_CHANNEL_CREATE_CMD;
        if is_create {
            match body[2] {
                CHANNEL_CREATE_MODE_BYTES => {
                    // 소비 — 발급·응답 모두 이 자리에서 끝낸다.
                    let response = bytes_channel_create_response(issue_bytes_channel());
                    write_frame_to_stdout(&response);
                    return Ok(());
                }
                CHANNEL_CREATE_MODE_JSON => { /* 통과 — 모듈이 JSON 발급 */ }
                _ => {
                    // 알 수 없는 미래 모드 — ok=0 으로 되돌린다. 구 런타임이 이
                    // 값을 무시하고 JSON 채널을 파는 조용한 불일치보다 loud-fail.
                    write_frame_to_stdout(&frame_with(vec![0u8; 8]));
                    return Ok(());
                }
            }
        }
        self.pending.extend_from_slice(&len_bytes);
        self.pending.extend_from_slice(&body);
        Ok(())
    }
}

impl<R: Read> Read for BytesChannelCreateReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        while self.pending.is_empty() && !self.done {
            self.fill_one_frame()?;
        }
        if self.pending.is_empty() {
            return Ok(0); // 깨끗한 EOF — run_binary 의 UnexpectedEof 종료와 동일.
        }
        let count = buf.len().min(self.pending.len());
        buf[..count].copy_from_slice(&self.pending[..count]);
        self.pending.drain(..count);
        Ok(count)
    }
}
