//! Complex binary 라우트 왕복 벤치마크 — Track A (스키마 IR 사전컴파일) 효과 측정.
//!
//! data enum(oneOf)과 `Vec<u64>`/`Option<i64>` 필드는 JS postcard 코덱 미지원 →
//! complex binary 라우트로 라우팅되는 정적 명령. 원본 런타임은 매 호출
//! `resolved_schema` 클론 + `variants` 클론+정렬을 했고, Track A 이후 빌드
//! 시점 1회 컴파일된 IR 만 순회한다.
//!
//! 실행: `cargo bench -p rustra --bench complex_route --profile dev`

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use rustra::Package;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[path = "common.rs"]
mod common;

// ── data enum(oneOf) complex 라우트 ─────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Active { level: i64 },
    Idle,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OneOfIn {
    pub status: Status,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OneOfOut {
    pub status: Status,
}

pub fn oneof_echo(input: OneOfIn) -> rustra::Result<OneOfOut> {
    Ok(OneOfOut {
        status: input.status,
    })
}

// ── map 복합 타입 complex 라우트 ────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupsIn {
    pub groups: std::collections::BTreeMap<String, Vec<i64>>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GroupsOut {
    pub groups: std::collections::BTreeMap<String, Vec<i64>>,
}

pub fn groups_echo(input: GroupsIn) -> rustra::Result<GroupsOut> {
    Ok(GroupsOut {
        groups: input.groups,
    })
}

fn build_pkg() -> Package {
    Package::builder("bench.complex_route")
        .command("oneofEcho", oneof_echo)
        .command("groupsEcho", groups_echo)
        .build()
}

fn bench_complex_route(c: &mut Criterion) {
    let pkg = build_pkg();
    let oneof_id = common::command_id_of(&pkg, "oneofEcho");
    let groups_id = common::command_id_of(&pkg, "groupsEcho");

    // oneOf 와이어: [variant index][active.level zigzag varint] — wire fixture
    // 와 동일 인코딩(rkyv_v2_wire::oneof_command_uses_complex_binary_wire).
    let oneof_req = [oneof_id as u8, (oneof_id >> 8) as u8, 0, 14];

    // groups 와이어: map count(1) + key "g"(len 1) + seq count(2) + zigzag 원소.
    let groups_req = [
        groups_id as u8,
        (groups_id >> 8) as u8,
        1,
        1,
        b'g',
        2,
        84, /* zigzag 42 */
        86, /* zigzag -43 */
    ];

    // smoke — 와이어가 틀리면 벤치가 무의미해지므로 즉시 실패시킨다.
    let resp = pkg
        .invoke_rkyv_v2(&oneof_req)
        .expect("oneof complex invoke must succeed");
    assert_eq!(resp[0], 1, "oneof ok");
    assert_eq!(&resp[8..], &[0, 14], "oneof echo body");
    let resp = pkg
        .invoke_rkyv_v2(&groups_req)
        .expect("groups complex invoke must succeed");
    assert_eq!(resp[0], 1, "groups ok");

    let mut group = c.benchmark_group("complex_route");
    group.sample_size(500);
    group.bench_function(BenchmarkId::new("invoke_rkyv_v2", "oneof_data_enum"), |b| {
        b.iter(|| {
            let resp = pkg.invoke_rkyv_v2(&oneof_req).unwrap();
            std::hint::black_box(&resp);
        });
    });
    group.bench_function(BenchmarkId::new("invoke_rkyv_v2", "map_of_seqs"), |b| {
        b.iter(|| {
            let resp = pkg.invoke_rkyv_v2(&groups_req).unwrap();
            std::hint::black_box(&resp);
        });
    });
    group.finish();
}

criterion_group!(benches, bench_complex_route);
criterion_main!(benches);
