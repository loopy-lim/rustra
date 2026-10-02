use rustra_calculator_example::calculator_package;
use serde_json::{Value, json};
use std::io::{BufRead, Read, Write};

fn main() -> rustra::Result<()> {
    match std::env::args().nth(1).as_deref() {
        Some("invoke") => return run_invoke_stdio(),
        Some("serve") => return run_serve_stdio(),
        _ => {}
    }

    let package = calculator_package();
    let result = package.invoke_json("addNumbers", json!({"a": 2, "b": 3}))?;
    let value = result.get("value").and_then(|v| v.as_i64()).unwrap_or(0);

    // 데모 실행이 generated/ 를 오염시키지 않는다 — TS 표면 재생성은 `rustra codegen`.
    println!("2 + 3 = {}", value);
    Ok(())
}

fn run_invoke_stdio() -> rustra::Result<()> {
    let mut input = String::new();
    std::io::stdin()
        .take(1024 * 1024)
        .read_to_string(&mut input)?;
    let response = invoke_response(&calculator_package(), &input);
    serde_json::to_writer(std::io::stdout(), &response).map_err(rustra::RustraError::internal)?;
    Ok(())
}

fn run_serve_stdio() -> rustra::Result<()> {
    let package = calculator_package();
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let response = invoke_response(&package, &line);
        serde_json::to_writer(&mut stdout, &response).map_err(rustra::RustraError::internal)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

fn invoke_response(package: &rustra::Package, input: &str) -> Value {
    let request: Value = match serde_json::from_str(input) {
        Ok(request) => request,
        Err(error) => return error_response(rustra::RustraError::invalid_args(error)),
    };
    let mut response = match handle_request(package, &request) {
        Ok(response) => response,
        Err(error) => error_response(error),
    };
    if let Some(id) = request.get("id") {
        response["id"] = id.clone();
    }
    response
}

fn error_response(error: rustra::RustraError) -> Value {
    let detail = serde_json::to_string(&error).unwrap_or_else(|_| error.to_string());
    json!({ "ok": false, "error": detail })
}

fn handle_request(package: &rustra::Package, request: &Value) -> rustra::Result<Value> {
    let command = request
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| rustra::RustraError::invalid_args("missing command"))?;
    if command == "__rustra_contract" {
        return Ok(json!({ "ok": true, "result": package.generate_typescript()?.contract_hash }));
    }
    if command == "__rustra_capabilities" {
        return Ok(json!({ "ok": true, "result": { "events": "polling" } }));
    }
    if command == "__drainEvents" {
        let events: Vec<Value> = package
            .event_bus()
            .take_pending_events()
            .into_iter()
            .map(|event| {
                let payload: Value =
                    serde_json::from_str(&event.payload).unwrap_or(Value::String(event.payload));
                json!({ "name": event.name, "payload": payload })
            })
            .collect();
        return Ok(json!({ "ok": true, "events": events }));
    }
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    let result = package.invoke_json(command, args)?;
    Ok(json!({ "ok": true, "result": result }))
}
