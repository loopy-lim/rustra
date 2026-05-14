use rustra::tauri_support;
use rustra_calculator_example::{calculator_package, AddNumbersOutput};
use std::{env, fs};

fn main() {
    if let Ok(path) = env::var("RUSTRA_TAURI_PROBE_FILE") {
        let output: AddNumbersOutput = calculator_package()
            .invoke(
                "addNumbers",
                rustra_calculator_example::AddNumbersInput { a: 20, b: 22 },
            )
            .expect("invoke should succeed");
        let _ = fs::write(path, output.value.to_string());
    }

    let builder = tauri_support::register(calculator_package(), tauri::Builder::default());

    builder
        .run(tauri::generate_context!())
        .expect("failed to run tauri calculator app");
}
