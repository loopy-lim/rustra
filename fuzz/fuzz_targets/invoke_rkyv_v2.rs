#![no_main]
//! invoke_rkyv_v2 퍼징 — 2바이트 command_id(LE) + postcard 본문의 무작위 바이트에
//! 대해 패닉/UB 없이 Err 로 거부되는지(또는 정상 응답하는지) 검증한다.
//!
//! 타깃 근거: `Package::invoke_rkyv_v2` (crates/rustra/src/lib.rs) 가 rkyv V2
//! fast-path 의 신뢰 경계 디스패치이며, FFI 진입점(`rustra_ffi_invoke_*`,
//! `rustra_template_invoke_rkyv_v2`)이 같은 디스패치를 공유한다 — 이 함수를
//! 직접 타깃하면 디코드 경로 전체를 덮는다.
//!
//! 페이로드는 원본과 1KiB 상한 컷 두 경로로 주입해 디코더 경로를 집중 공격한다.

use libfuzzer_sys::fuzz_target;
use rustra::prelude::*;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct AddInput {
    a: i64,
    b: i64,
}

#[command]
fn fuzz_add(input: AddInput) -> Result<i64> {
    // checked_add — 퍼징 중 산술 오버플로 패닉이 실제 버그로 오인되지 않게.
    input
        .a
        .checked_add(input.b)
        .ok_or_else(|| RustraError::custom("math.overflow", "i64 overflow"))
}

fn fuzz_package() -> Package {
    // debug 빌드에서만 유효한 패키지를 매 iteration 재생성하지 않도록 OnceLock 로 캐시.
    // register! 매크로 사용 패턴은 examples/calculator/src/lib.rs 와 동일.
    static CACHED: std::sync::OnceLock<Package> = std::sync::OnceLock::new();
    CACHED
        .get_or_init(|| register!(Package::builder("fuzz.pkg"), fuzz_add).done())
        .clone()
}

fuzz_target!(|data: &[u8]| {
    let pkg = fuzz_package();
    // Err 인코딩/정상 응답 모두 "패닉 없이 반환" 이 성공 조건.
    let _ = pkg.invoke_rkyv_v2(data);
    // 초과 길이는 상한 컷으로 디코더 집중.
    let clipped = &data[..data.len().min(1024)];
    let _ = pkg.invoke_rkyv_v2(clipped);
});
