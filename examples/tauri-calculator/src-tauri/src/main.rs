use rustra::tauri_support;
use rustra_calculator_example::calculator_package;
use std::{env, fs};

fn main() {
    if let Ok(path) = env::var("RUSTRA_TAURI_PROBE_FILE") {
        let output = calculator_package()
            .invoke_json("addNumbers", serde_json::json!({"a": 20, "b": 22}))
            .expect("invoke should succeed");
        let value = output.as_i64().expect("result should be a number");
        let _ = fs::write(path, value.to_string());
    }

    let builder = tauri_support::register(calculator_package(), tauri::Builder::default());

    builder
        .run(tauri::generate_context!())
        .expect("failed to run tauri calculator app");
}
