//! Tier 비교 벤치마크 — 동일 의미(add/echo)를 세 가지 wire 로 측정한다.
//!
//! (a) 정적 Tier 1 (primitive, postcard fast-path)
//! (b) 정적 Tier 2 (String, postcard fast-path)
//! (c) 동적 Tier 3 (런타임 register, JSON-in-binary fallback)
//!
//! 실행: `cargo bench -p rustra --profile dev -- tier_compare`
//! (dynamic 경로는 register 로만 도달 → debug 빌드 필수. dynamic 명령은 dev-only 설계.)

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use rustra::Package;

#[path = "common.rs"]
mod common;

fn build_pkg() -> Package {
    // 정적 Tier 1 / Tier 2 명령을 빌더로, 동적 Tier 3 는 register 로 추가.
    // debug 빌드여야 mutable 하다.
    let pkg = Package::builder("bench.tier_compare")
        .command("add", common::add)
        .command("greet", common::greet)
        .build();
    pkg.register("echo", common::echo)
        .expect("register must work in debug build");
    pkg
}

fn bench_tier_compare(c: &mut Criterion) {
    let pkg = build_pkg();

    // 각 commandId 조회 (하드코딩 회피).
    let add_id = common::command_id_of(&pkg, "add");
    let greet_id = common::command_id_of(&pkg, "greet");
    let echo_id = common::command_id_of(&pkg, "echo");

    // 요청 페이로드를 미리 빌드 — 측정은 invoke_rkyv_v2 자체만.
    let add_input = common::AddInput { a: 42, b: 58 };
    let add_req = common::postcard_request(add_id, &add_input);

    let greet_input = common::GreetInput {
        name: "world".into(),
    };
    let greet_req = common::postcard_request(greet_id, &greet_input);

    let echo_json = r#"{"v":7}"#;
    let echo_req = common::tier3_request(echo_id, echo_json);

    let mut group = c.benchmark_group("tier_compare");
    group.sample_size(500);

    group.bench_function(
        BenchmarkId::new("invoke_rkyv_v2", "static_tier1_postcard"),
        |b| {
            b.iter(|| {
                let resp = pkg.invoke_rkyv_v2(&add_req).unwrap();
                let out: common::AddOutput = common::decode_postcard_response(&resp);
                out
            });
        },
    );

    group.bench_function(
        BenchmarkId::new("invoke_rkyv_v2", "static_tier2_postcard"),
        |b| {
            b.iter(|| {
                let resp = pkg.invoke_rkyv_v2(&greet_req).unwrap();
                let out: common::GreetOutput = common::decode_postcard_response(&resp);
                out
            });
        },
    );

    group.bench_function(
        BenchmarkId::new("invoke_rkyv_v2", "dynamic_tier3_json"),
        |b| {
            b.iter(|| {
                let resp = pkg.invoke_rkyv_v2(&echo_req).unwrap();
                common::decode_tier3_response(&resp)
            });
        },
    );

    group.finish();
}

criterion_group!(benches, bench_tier_compare);
criterion_main!(benches);
