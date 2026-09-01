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
//! 프로토콜 구현 본체는 `rustra_calculator_example::loop_stdio` 모듈 — 통합
//! 테스트(`tests/loop_stdio_events.rs`)가 같은 모듈을 직접 검증한다.

use rustra_calculator_example::calculator_package;
use rustra_calculator_example::loop_stdio::{
    PUSH_CAPABILITY, handle_hello_with_policy, hello_response, run_binary,
};
use serde_json::{Value, json};
use std::io::{BufRead, Write};

fn main() -> rustra::Result<()> {
    let package = calculator_package();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
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
            let mut encoded = serde_json::to_vec(&hello_response(echo_id, events_mode))
                .map_err(rustra::RustraError::internal)?;
            encoded.push(b'\n');
            out.write_all(&encoded)
                .map_err(rustra::RustraError::internal)?;
            out.flush().map_err(rustra::RustraError::internal)?;
            return run_binary(&package, &mut reader, &mut out);
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
