use rustra_calculator_example::calculator_package;
use serde_json::{Value, json};
use std::io::{Read, Write};

fn main() -> rustra::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("invoke") {
        return run_invoke_stdio();
    }

    let package = calculator_package();
    let result = package.invoke_json("addNumbers", json!({"a": 2, "b": 3}))?;
    let value = result.get("value").and_then(|v| v.as_i64()).unwrap_or(0);

    let generated = package.generate_typescript()?;
    generated.write_to_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/generated"))?;

    println!("2 + 3 = {}", value);
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
    if command == "__rustra_contract" {
        let hash = calculator_package().generate_typescript()?.contract_hash;
        let response = serde_json::to_vec(&json!({ "ok": true, "result": hash }))
            .map_err(rustra::RustraError::internal)?;
        std::io::stdout().write_all(&response)?;
        return Ok(());
    }
    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));
    let result = calculator_package().invoke_json(command, args)?;
    let response = serde_json::to_vec(&json!({ "ok": true, "result": result }))
        .map_err(rustra::RustraError::internal)?;
    std::io::stdout().write_all(&response)?;
    Ok(())
}
