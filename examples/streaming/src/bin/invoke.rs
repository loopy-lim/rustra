//! stdio JSON invoke 서버 — streaming 예제.
//!
//! 두 모드:
//! - 단발(기본): 요청 1건 처리 후 종료. calculator 패턴과 동일.
//! - 라인 데몬(`--serve`): stdin 의 각 JSON 라인을 처리해 한 라인 응답.
//!   **같은 프로세스가 살아있으므로 전역 이벤트 버스가 유지된다** — 이벤트
//!   스트리밍 데모의 전제. Node 앱은 이 모드를 사용한다.
//!
//! 요청(stdin): `{"command": "startJob", "args": {...}}` 한 줄
//! 응답(stdout): `{"ok": true, "result": ...}` 한 줄
//!
//! 내부 폴링 명령 `__drainEvents`: 대기 중 이벤트 배열 반환.

use rustra_streaming_example::streaming_package;
use serde_json::json;
use std::io::{BufRead, Write};

fn main() -> rustra::Result<()> {
    let serve = std::env::args().nth(1).as_deref() == Some("--serve");
    if serve {
        return run_serve();
    }
    run_single()
}

fn run_single() -> rustra::Result<()> {
    let mut input = String::new();
    std::io::stdin().read_line(&mut input)?;
    let response = handle(&input)?;
    std::io::stdout().write_all(&response)?;
    Ok(())
}

fn run_serve() -> rustra::Result<()> {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let line = line.map_err(rustra::RustraError::internal)?;
        if line.trim().is_empty() {
            continue;
        }
        let response = handle(&line)?;
        stdout.write_all(&response)?;
        stdout.write_all(b"\n")?;
        stdout.flush().ok();
    }
    Ok(())
}

fn handle(input: &str) -> rustra::Result<Vec<u8>> {
    let request: serde_json::Value =
        serde_json::from_str(input).map_err(rustra::RustraError::invalid_args)?;
    let command = request
        .get("command")
        .and_then(|v| v.as_str())
        .ok_or_else(|| rustra::RustraError::invalid_args("missing command"))?
        .to_string();
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    // 요청 id 에코 — 멀티플렉싱 대응 (없으면 생략).
    let id = request.get("id").cloned();

    let respond = |mut body: serde_json::Value| -> rustra::Result<Vec<u8>> {
        if let Some(id) = id {
            body["id"] = id;
        }
        serde_json::to_vec(&body).map_err(rustra::RustraError::internal)
    };

    if command == "__drainEvents" {
        let events: Vec<serde_json::Value> = rustra_streaming_example::event_bus()
            .take_pending_events()
            .into_iter()
            .map(|e| {
                json!({
                    "name": e.name,
                    "payload": serde_json::from_str::<serde_json::Value>(&e.payload)
                        .unwrap_or(json!({})),
                    "seq": e.seq
                })
            })
            .collect();
        return respond(json!({ "ok": true, "result": events }));
    }

    let result = streaming_package().invoke_json(&command, args)?;
    respond(json!({ "ok": true, "result": result }))
}
