//! lib.rs 파사드 예산(200줄) 유지 — 내부 테스트 모듈 등록소.
//!
//! 각 테스트 모듈은 `crate::` 경로로 임포트한다(중첩 `super::` 의존 없이 이
//! 파일 아래에서도 깨지지 않게). 신규 내부 테스트 모듈도 여기에 등록한다.

mod buffer_invoke_tests;
mod builder_devices_tests;
mod builder_errors_tests;
mod builder_platform_tests;
mod complex_codec_adjacent_tests;
mod complex_codec_malformed_tests;
mod complex_into_tests;
mod raw_invoke_tests;
mod runtime_registry_tests;
