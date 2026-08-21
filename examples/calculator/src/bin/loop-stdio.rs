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
//! 이벤트: `{"command":"__drainEvents"}` 특수 요청으로 대기 중 이벤트를
//! `{"id":..,"ok":true,"events":[..]}` 로 받는다(폴링). 패키지를 한 번만
//! 구축하므로 런타임 등록/스키마 비용이 첫 요청에만 발생한다.

use rustra_calculator_example::calculator_package;
use serde_json::{Value, json};
use std::io::{BufRead, Write};

fn main() -> rustra::Result<()> {
    let package = calculator_package();
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = line.map_err(rustra::RustraError::internal)?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = handle_line(&package, trimmed);
        let mut encoded = serde_json::to_vec(&response).map_err(rustra::RustraError::internal)?;
        encoded.push(b'\n');
        out.write_all(&encoded)
            .map_err(rustra::RustraError::internal)?;
        // 라인 단위 flush — 호출자가 파이프에서 라인을 기다린다.
        out.flush().map_err(rustra::RustraError::internal)?;
    }
    Ok(())
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
