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

    // 등록 선택 — 기본은 프로덕션 등록(register_with_events: register + 이벤트
    // 푸시 배선). 벤치 호스트(benchmark.mjs)만 RUSTRA_BENCH=1 로 띄우며, 이때는
    // 측정 전용 rustra_dispatch_profiled 커맨드가 노출되는 register_profiled 로
    // 빌드한다(A07). 프로덕션 앱에는 profiled 커맨드가 도달하지 않는다.
    let builder = if env::var("RUSTRA_BENCH").as_deref() == Ok("1") {
        tauri_support::register_profiled(calculator_package(), tauri::Builder::default())
    } else {
        tauri_support::register_with_events(calculator_package(), tauri::Builder::default())
    };

    builder
        .run(tauri::generate_context!())
        .expect("failed to run tauri calculator app");
}
