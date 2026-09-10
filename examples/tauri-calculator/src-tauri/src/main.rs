// 데스크톱 엔트리 — 본체는 lib.rs 의 run()(모바일 공유). lib/bin 분리는 Tauri 2
// 모바일 빌드의 필수 레이아웃이다.
fn main() {
    rustra_tauri_calculator_lib::run()
}
