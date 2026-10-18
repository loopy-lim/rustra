//! Runnable resident state + generated TypeScript client: examples/resident-tree/run.mjs.
#[path = "support/resident_tree_model.rs"]
mod model;
use serde_json::{Value, json};
use std::io::{BufRead, Write};

fn main() -> rustra::Result<()> {
    let package = model::package();
    if std::env::args().nth(1).as_deref() == Some("schema") {
        print!("{}", package.generate_typescript()?.schema_json);
        return Ok(());
    }
    let mut stdin = std::io::stdin().lock();
    let mut stdout = std::io::stdout().lock();
    let mut bytes = Vec::new();
    loop {
        bytes.clear();
        // Read through a bounded reader; oversized lines terminate this owned process.
        let read =
            std::io::Read::take(&mut stdin, 2 * 1024 * 1024 + 1).read_until(b'\n', &mut bytes)?;
        if read == 0 {
            break;
        }
        if read > 2 * 1024 * 1024 {
            return Err(rustra::RustraError::invalid_args("request too large"));
        }
        let request: Value =
            serde_json::from_slice(&bytes).map_err(rustra::RustraError::invalid_args)?;
        let command = request["command"].as_str().unwrap_or("");
        let result = if command == "__rustra_contract" {
            Ok(json!(package.generate_typescript()?.contract_hash))
        } else {
            package.invoke_json(command, request.get("args").cloned().unwrap_or(Value::Null))
        };
        let response = match result {
            Ok(value) => json!({"id":request["id"],"ok":true,"result":value}),
            Err(error) => {
                json!({"id":request["id"],"ok":false,"error":serde_json::to_string(&error).map_err(rustra::RustraError::internal)?})
            }
        };
        serde_json::to_writer(&mut stdout, &response).map_err(rustra::RustraError::internal)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}
