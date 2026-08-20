//! crud 예제의 실행 진입점 — calculator 예제와 동일한 stdio invoke 프로토콜.
//!
//! `rustra-crud-example invoke` 실행 시 stdin 의 `{command, args}` JSON 을
//! 받아 `{ok, result}` 를 stdout 으로 돌려준다. createNodeProcessTransport
//! (@rustra/node)와 레퍼런스 앱(examples/reference-app)이 이 진입점을 쓴다.

use rustra_crud_example::crud_package;
use serde_json::{Value, json};
use std::io::{Read, Write};

fn main() -> rustra::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("invoke") {
        return run_invoke_stdio();
    }

    let package = crud_package();
    let result = package.invoke_json("listItems", json!({}))?;
    let count = result
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0);
    println!("crud: {count} item(s)");
    Ok(())
}

fn run_invoke_stdio() -> rustra::Result<()> {
    let mut input = String::new();
    std::io::stdin()
        .take(1024 * 1024)
        .read_to_string(&mut input)?;
    let request: Value = serde_json::from_str(&input).map_err(rustra::RustraError::invalid_args)?;
    let command = request
        .get("command")
        .and_then(Value::as_str)
        .ok_or_else(|| rustra::RustraError::invalid_args("missing command"))?;
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    let result = crud_package().invoke_json(command, args)?;
    let response = serde_json::to_vec(&json!({ "ok": true, "result": result }))
        .map_err(rustra::RustraError::internal)?;
    std::io::stdout().write_all(&response)?;
    Ok(())
}
