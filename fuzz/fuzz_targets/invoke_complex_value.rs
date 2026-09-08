#![no_main]
//! invoke_complex_value 퍼징 — complex 바이너리 라우트 중 Value 경로
//! (`CompiledComplex::decode` → `decode_node_ir`) 프레임 디코더를 무작위
//! 바이트로 공격한다. 임의 바이트는 패닉/UB/무한 루프 없이 Err 로 거부되거나
//! (정말 유효한 입력이면) Ok 로 응답해야 한다.
//!
//! 타깃 근거: adjacent tagged enum(변형 키가 title/프로퍼티명에서 유도되는
//! `IrBody::Node` 본체)은 serde 직결 게이트(`serde_direct_supported`)를
//! 통과하지 못해 Value 경로에 남는다 — complex 라우트 디코더의 신뢰 경계.
//! 와이어는 `[command_id u16 LE][complex 본문]` 프레임(invoke_rkyv_v2 참조).
//!
//! 페이로드는 id 1 프레임으로 감싸 본문 전체가 디코더로 가는 경로와, 원본
//! 그대로(앞 2바이트가 id 로 재해석) 경로, 그리고 1KiB 상한 컷 세 가지로
//! 주입한다.

use libfuzzer_sys::fuzz_target;
use rustra::prelude::*;
use std::collections::BTreeMap;

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "t", content = "c")]
enum FuzzGate {
    #[schemars(title = "Txt")]
    Txt(String),
    #[schemars(title = "Nums")]
    Nums(BTreeMap<String, i64>),
    #[schemars(title = "Off")]
    Off,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct GateInput {
    event: FuzzGate,
    tags: Vec<i64>,
}

#[command]
fn gate_echo(input: GateInput) -> Result<GateInput> {
    Ok(input)
}

fn fuzz_package() -> Package {
    // debug 빌드에서도 패키지 재생성을 한 번으로 잘라두는 캐시 — 기존 타깃과
    // 동일한 register! 사용 패턴.
    static CACHED: std::sync::OnceLock<Package> = std::sync::OnceLock::new();
    CACHED
        .get_or_init(|| register!(Package::builder("fuzz.complex-value"), gate_echo).done())
        .clone()
}

/// catch_unwind 가드가 핸들러 패닉을 internal("panic in handler: …") 로
/// 정규화한다 — 무작위 바이트가 이 코드를 유발하면 디코더 버그이므로
/// libfuzzer 크래시로 승격한다.
fn deny_panic_guard<T>(result: rustra::Result<T>) {
    if let Err(error) = result {
        assert!(
            !error.message().starts_with("panic in handler"),
            "complex value decoder panicked: {error}"
        );
    }
}

fuzz_target!(|data: &[u8]| {
    let pkg = fuzz_package();

    let mut frame = Vec::with_capacity(data.len().min(1024) + 2);
    frame.extend_from_slice(&1u16.to_le_bytes());
    frame.extend_from_slice(&data[..data.len().min(1024)]);
    deny_panic_guard(pkg.invoke_rkyv_v2(&frame));

    let mut target = [0u8; 1024];
    deny_panic_guard(pkg.invoke_rkyv_v2_into(&frame, &mut target));

    // 원본 그대로 — 앞 2바이트가 command_id 로 재해석되는 경로(unknown id,
    // too short 포함).
    let clipped = &data[..data.len().min(1024)];
    deny_panic_guard(pkg.invoke_rkyv_v2(clipped));
});
