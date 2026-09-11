#![no_main]
//! invoke_complex_serde 퍼징 — complex 바이너리 라우트 중 serde 직결 경로
//! (`CompiledComplex::decode_direct` → `complex_serde::from_bytes`) 디스패처를
//! 무작위 바이트로 공격한다. 임의 바이트는 패닉/UB/무한 루프 없이 Err 로
//! 거부되거나 (정말 유효한 입력이면) Ok 로 응답해야 한다.
//!
//! 타깃 근거: 외부 tagged oneOf(신규 variant → `IrBody::UnwrapSingle`, 유닛
//! variant → `IrBody::EnumFirst`)는 직결 게이트를 통과해 트랙 B serde
//! 디시리얼라이저로 간다 — map/option/seq 필드를 함께 태워 `De`/`DeMap`/
//! `DeSeq` 전 경로를 덮는다. 와이어는 `[command_id u16 LE][complex 본문]`.
//!
//! 페이로드는 id 1 프레임 감싸기, 원본 재해석, 1KiB 상한 컷 세 경로로 주입한다.

use libfuzzer_sys::fuzz_target;
use rustra::prelude::*;
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
enum FuzzStatus {
    Active { level: i64 },
    Idle,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct StatusInput {
    entries: BTreeMap<String, i64>,
    status: FuzzStatus,
    note: Option<String>,
}

#[command]
fn status_echo(input: StatusInput) -> Result<StatusInput> {
    Ok(input)
}

fn fuzz_package() -> Package {
    // debug 빌드에서도 패키지 재생성을 한 번으로 잘라두는 캐시 — 기존 타깃과
    // 동일한 register! 사용 패턴.
    static CACHED: std::sync::OnceLock<Package> = std::sync::OnceLock::new();
    CACHED
        .get_or_init(|| register!(Package::builder("fuzz.complex-serde"), status_echo).done())
        .clone()
}

/// catch_unwind 가드가 핸들러 패닉을 internal("panic in handler: …") 로
/// 정규화한다 — 무작위 바이트가 이 코드를 유발하면 디코더 버그이므로
/// libfuzzer 크래시로 승격한다.
fn deny_panic_guard<T>(result: rustra::Result<T>) {
    if let Err(error) = result {
        assert!(
            !error.message().starts_with("panic in handler"),
            "complex serde decoder panicked: {error}"
        );
    }
}

fuzz_target!(|data: &[u8]| {
    let pkg = fuzz_package();

    let mut frame = Vec::with_capacity(data.len().min(1024) + 2);
    frame.extend_from_slice(&1u16.to_le_bytes());
    frame.extend_from_slice(&data[..data.len().min(1024)]);
    deny_panic_guard(pkg.invoke_frame(&frame));

    let mut target = [0u8; 1024];
    deny_panic_guard(pkg.invoke_frame_into(&frame, &mut target));

    // 원본 그대로 — 앞 2바이트가 command_id 로 재해석되는 경로(unknown id,
    // too short 포함).
    let clipped = &data[..data.len().min(1024)];
    deny_panic_guard(pkg.invoke_frame(clipped));
});
