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

// ── recursive $ref complex route ──────────────────────────

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ChainNode {
    pub value: i64,
    pub next: Option<Box<ChainNode>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecursiveIn {
    pub root: ChainNode,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RecursiveOut {
    pub root: ChainNode,
}

pub fn recursive_echo(input: RecursiveIn) -> rustra::Result<RecursiveOut> {
    Ok(RecursiveOut { root: input.root })
}

fn push_uvar(mut value: u64, output: &mut Vec<u8>) {
    while value >= 0x80 {
        output.push((value as u8) | 0x80);
        value >>= 7;
    }
    output.push(value as u8);
}

/// Positive `i64` values 1..=depth followed by an optional next pointer.
/// `next` has both a non-required struct-field tag and an Option tag, so each
/// node is `[zigzag(value)][field-present=1][next-present]`.
fn recursive_request(command_id: u16, depth: usize) -> Vec<u8> {
    assert!(depth > 0);
    let mut request = Vec::with_capacity(2 + depth * 3);
    request.extend_from_slice(&command_id.to_le_bytes());
    for value in 1..=depth {
        push_uvar((value as u64) << 1, &mut request);
        request.push(1);
        request.push(u8::from(value < depth));
    }
    request
}

fn build_pkg() -> Package {
    Package::builder("bench.complex_route")
        .command("oneofEcho", oneof_echo)
        .command("groupsEcho", groups_echo)
        .command("recursiveEcho", recursive_echo)
        .build()
}

fn bench_complex_route(c: &mut Criterion) {
    let pkg = build_pkg();
    let oneof_id = common::command_id_of(&pkg, "oneofEcho");
    let groups_id = common::command_id_of(&pkg, "groupsEcho");
    let recursive_id = common::command_id_of(&pkg, "recursiveEcho");

    // oneOf 와이어: [variant index][active.level zigzag varint] — wire fixture
    // 와 동일 인코딩(frame_wire::oneof_command_uses_complex_binary_wire).
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
    let recursive_depth_1 = recursive_request(recursive_id, 1);
    let recursive_depth_8 = recursive_request(recursive_id, 8);

    // smoke — 와이어가 틀리면 벤치가 무의미해지므로 즉시 실패시킨다.
    let resp = pkg
        .invoke_frame(&oneof_req)
        .expect("oneof complex invoke must succeed");
    assert_eq!(resp[0], 1, "oneof ok");
    assert_eq!(&resp[8..], &[0, 14], "oneof echo body");
    let resp = pkg
        .invoke_frame(&groups_req)
        .expect("groups complex invoke must succeed");
    assert_eq!(resp[0], 1, "groups ok");
    for request in [&recursive_depth_1, &recursive_depth_8] {
        let resp = pkg
            .invoke_frame(request)
            .expect("recursive complex invoke must succeed");
        assert_eq!(resp[0], 1, "recursive ok");
        assert_eq!(&resp[8..], &request[2..], "recursive echo body");
    }

    let mut group = c.benchmark_group("complex_route");
    group.sample_size(500);
    group.bench_function(BenchmarkId::new("invoke_frame", "oneof_data_enum"), |b| {
        b.iter(|| {
            let resp = pkg.invoke_frame(&oneof_req).unwrap();
            std::hint::black_box(&resp);
        });
    });
    group.bench_function(BenchmarkId::new("invoke_frame", "map_of_seqs"), |b| {
        b.iter(|| {
            let resp = pkg.invoke_frame(&groups_req).unwrap();
            std::hint::black_box(&resp);
        });
    });
    group.bench_function(BenchmarkId::new("invoke_frame", "recursive_depth_1"), |b| {
        b.iter(|| {
            let resp = pkg.invoke_frame(&recursive_depth_1).unwrap();
            std::hint::black_box(&resp);
        });
    });
    group.bench_function(BenchmarkId::new("invoke_frame", "recursive_depth_8"), |b| {
        b.iter(|| {
            let resp = pkg.invoke_frame(&recursive_depth_8).unwrap();
            std::hint::black_box(&resp);
        });
    });
    group.finish();
}

criterion_group!(benches, bench_complex_route);
criterion_main!(benches);
