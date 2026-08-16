use rustra::tauri_support;
use rustra_calculator_example::calculator_package;
use std::{env, fs};

fn main() {
    if let Ok(path) = env::var("RUSTRA_TAURI_PROBE_FILE") {
        let output = calculator_package()
            .invoke_json("addNumbers", serde_json::json!({"a": 20, "b": 22}))
            .expect("invoke should succeed");
        let value = output
            .get("value")
            .and_then(|v| v.as_i64())
            .expect("result should be a number");
        let _ = fs::write(path, value.to_string());
    }

    // register_with_events: register(하위호환) + 이벤트 푸시 배선 — Package::emit 이
    // 즉시 app.emit("rustra://{name}", payload) 로 전달된다(폴링 불필요).
    let builder =
        tauri_support::register_with_events(calculator_package(), tauri::Builder::default());

    builder
        .run(tauri::generate_context!())
        .expect("failed to run tauri calculator app");
}
