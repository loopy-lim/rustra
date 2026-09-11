//! UniFFI 바인딩 생성기 — library 모드로 빌드된 cdylib 을 스캔해
//! Kotlin/Swift 바인딩을 뽑는다(--features uniffi 전용 bin).
//!
//! 사용 예:
//! cargo run -p rustra-calculator-example --bin uniffi-bindgen --features uniffi -- \
//!   generate --library target/debug/librustra_calculator_example.dylib \
//!   --language kotlin --language swift --out-dir uniffi

fn main() {
    uniffi::uniffi_bindgen_main()
}
