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
//! 요청  [len: u32 LE][rkyv V2 요청 프레임: cmd_id u16 LE + postcard 본문]
//! 응답  [len: u32 LE][rkyv V2 응답 프레임: [ok u8][pad 3B][len u32 LE][body]]
//! ```
//!
//! `len`은 항상 프레임 본문 길이(접두 제외)다. 응답은 호출 순서대로
//! 1:1 대응된다(파이프라이닝 없음 — transport 계약). 커맨드 id `0xFFFE`는
//! 이벤트 drain 예약으로, 응답 본문에 대기 이벤트의 JSON 배열을 실는다.
//! 기존 NDJSON 소비자는 핸드셰이크를 보내지 않으면 계속 라인 프로토콜을
//! 그대로 쓴다(무중단 호환).

use rustra_calculator_example::calculator_package;
use serde_json::{Value, json};
use std::io::{BufRead, Read, Write};

/// 이벤트 drain 예약 커맨드 id (바이너리 모드). 자동 부여 id(등록 순서)와
/// 충돌하지 않는 u16 상한부다.
const BINARY_DRAIN_EVENTS_CMD: u16 = 0xFFFE;

fn main() -> rustra::Result<()> {
    let package = calculator_package();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    let mut reader = stdin.lock();

    let mut line = String::new();
    loop {
        line.clear();
        let read = reader.read_line(&mut line).map_err(rustra::RustraError::internal)?;
        if read == 0 {
            return Ok(()); // stdin EOF
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.contains("__hello") {
            if let Some(true) = hello_requested(trimmed) {
                let response = json!({
                    "id": 0,
                    "ok": true,
                    "binary": true,
                    "eventsCmdId": BINARY_DRAIN_EVENTS_CMD,
                });
                let mut encoded =
                    serde_json::to_vec(&response).map_err(rustra::RustraError::internal)?;
                encoded.push(b'\n');
                out.write_all(&encoded).map_err(rustra::RustraError::internal)?;
                out.flush().map_err(rustra::RustraError::internal)?;
                return run_binary(package, &mut reader, &mut out);
            }
        }
        let response = handle_line(&package, trimmed);
        let mut encoded = serde_json::to_vec(&response).map_err(rustra::RustraError::internal)?;
        encoded.push(b'\n');
        out.write_all(&encoded)
            .map_err(rustra::RustraError::internal)?;
        // 라인 단위 flush — 호출자가 파이프에서 라인을 기다린다.
        out.flush().map_err(rustra::RustraError::internal)?;
    }
}

/// NDJSON 핸드셰이크 판별 — `{"command":"__hello"}` (id 는 무시).
fn hello_requested(line: &str) -> Option<bool> {
    let request: Value = serde_json::from_str(line).ok()?;
    let command = request.get("command").and_then(Value::as_str)?;
    Some(command == "__hello")
}

/// 바이너리 모드 루프 — 4B len 프레임을 read_exact 으로 읽고 rkyv V2 로
/// 직결 dispatch 한다. 응답 복사를 줄이기 위해 재사용 출력 버퍼에
/// `invoke_rkyv_v2_into` 로 기록하고(플러시 전까지 유지), 초과 응답만
/// core 의 probe 캐시 경유 Vec 으로 받는다.
fn run_binary<R: Read, W: Write>(
    package: rustra::Package,
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

        let response: Vec<u8> =
            if len >= 2 && u16::from_le_bytes([payload[0], payload[1]]) == BINARY_DRAIN_EVENTS_CMD {
                drain_events_binary(&package)
            } else {
                match package.invoke_rkyv_v2_into(&payload, &mut out_buffer) {
                    Ok(rustra::DirectResponse::Written(n)) => out_buffer[..n].to_vec(),
                    Ok(rustra::DirectResponse::Buffered(bytes)) => bytes,
                    Err(error) => rustra::encode_rkyv_v2_error(&error),
                }
            };

        out.write_all(&(response.len() as u32).to_le_bytes())
            .and_then(|_| out.write_all(&response))
            .and_then(|_| out.flush())
            .map_err(rustra::RustraError::internal)?;
    }
}

/// 바이너리 이벤트 drain — NDJSON `__drainEvents` 와 동일 페이로드를 JSON
/// 배열로 실어 보낸다(응답 프레임 [ok=1][pad][len][json]).
fn drain_events_binary(package: &rustra::Package) -> Vec<u8> {
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
