//! stdio JSON invoke 서버 — auth 예제. streaming 과 동일한 두 모드:
//! - 단발(기본): 요청 1건 처리 후 종료
//! - 라인 데몬(`--serve`): 각 JSON 라인 처리 — 세션 상태가 프로세스에 유지되므로
//!   signIn → grant → adminStats → signOut 시나리오가 한 연결 안에서 성립한다.

use rustra_auth_example::auth_package;
use serde_json::json;
use std::io::{BufRead, Write};

fn main() -> rustra::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--serve") {
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
    let id = request.get("id").cloned();

    // 에러도 JSON 응답으로 — Debug 프린트가 아니라 { code, message } 를 내려
    // JS 측 RustraCommandError 로 복원되게 한다.
    let body = match auth_package().invoke_json(&command, args) {
        Ok(result) => json!({ "ok": true, "result": result }),
        Err(e) => json!({ "ok": false, "error": { "code": e.code(), "message": e.message() } }),
    };
    let mut body = body;
    if let Some(id) = id {
        body["id"] = id;
    }
    serde_json::to_vec(&body).map_err(rustra::RustraError::internal)
}
