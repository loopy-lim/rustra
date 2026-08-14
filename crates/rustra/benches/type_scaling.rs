//! 동적 Tier 3 경로 payload scaling 벤치마크 — dynamic 명령의 데이터 크기별 확장성.
//!
//! 동적 `processPayload` 명령(register)을 1/10/100/1000 items 로 호출.
//! 측정: invoke_rkyv_v2 (Tier 3 JSON 디코드 → 핸들러 → Tier 3 인코드) end-to-end.
//!
//! 실행: `cargo bench -p rustra --profile dev -- type_scaling`

use criterion::{criterion_group, criterion_main, BenchmarkId, Criterion};
use rustra::Package;

#[path = "common.rs"]
mod common;

fn bench_type_scaling(c: &mut Criterion) {
    let pkg = Package::builder("bench.type_scaling").build();
    pkg.register("processPayload", common::process_payload)
        .expect("register must work in debug build");
    let id = common::command_id_of(&pkg, "processPayload");

    let sizes: &[usize] = &[1, 10, 100, 1000];

    let mut group = c.benchmark_group("type_scaling_tier3");
    group.sample_size(100);

    for &size in sizes {
        let items = common::make_items(size);
        let input = common::PayloadInput { items };
        let json = serde_json::to_string(&input).unwrap();
        let req = common::tier3_request(id, &json);

        group.bench_with_input(
            BenchmarkId::new("invoke_rkyv_v2_tier3", format!("{size}_items")),
            &req,
            |b, req| {
                b.iter(|| {
                    let resp = pkg.invoke_rkyv_v2(req).unwrap();
                    common::decode_tier3_response(&resp);
                });
            },
        );
    }

    group.finish();
}

criterion_group!(benches, bench_type_scaling);
criterion_main!(benches);
