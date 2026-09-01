//! 런타임 레지스트리 비용 벤치마크 — dynamic import 경로의 부수 비용 측정.
//!
//! (1) register() 1회 비용 (스키마 생성 포함)
//! (2) live_schema() 조회 비용
//! (3) frozen vs mutable 상태의 invoke_rkyv_v2 read 경로 차이 (RwLock read 영향)
//!
//! 실행: `cargo bench -p rustra --profile dev -- dynamic_registry`

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use rustra::Package;

#[path = "common.rs"]
mod common;

fn fresh_pkg() -> Package {
    Package::builder("bench.dynamic_registry")
        .command("add", common::add)
        .build()
}

fn bench_register(c: &mut Criterion) {
    let mut group = c.benchmark_group("dynamic_registry_register");
    group.sample_size(200);

    // register() 1회 비용. 매 iteration 마다 fresh pkg 필요 → setup 비용은 제외(measured separately).
    // criterion 의 iter_batched 로 batch(사전 pkg 생성)와 routine(register)을 분리.
    use criterion::BatchSize;
    group.bench_function(BenchmarkId::new("register", "echo_tier3"), |b| {
        b.iter_batched(
            fresh_pkg,
            |pkg| pkg.register("echo", common::echo).unwrap(),
            BatchSize::SmallInput,
        );
    });

    group.finish();
}

fn bench_live_schema(c: &mut Criterion) {
    let pkg = fresh_pkg();
    pkg.register("echo", common::echo).unwrap();

    let mut group = c.benchmark_group("dynamic_registry_live_schema");
    group.sample_size(500);

    group.bench_function(BenchmarkId::new("live_schema", "3_commands"), |b| {
        b.iter(|| pkg.live_schema());
    });

    group.finish();
}

fn bench_invoke_frozen_vs_mutable(c: &mut Criterion) {
    // mutable 패키지 (debug 기본)
    // echo({v:i64})는 postcard 지원 형태라 등록 시 binary 핸들러로 승격된다
    // (639a494b, runtime_registry_tests::dynamic_unsupported_schema_stays_tier3
    // 계약) — 따라서 요청/응답 모두 postcard 와이어를 사용한다. 구 tier3 JSON
    // 와이어를 쓰면 응답 디코드가 어긋나 벤치가 패닉했다.
    let pkg_mut = fresh_pkg();
    pkg_mut.register("echo", common::echo).unwrap();
    let echo_id_mut = common::command_id_of(&pkg_mut, "echo");
    let input_mut = common::EchoInput { v: 1 };
    let req_mut = common::postcard_request(echo_id_mut, &input_mut);

    // frozen 패키지 (명시적 freeze 후 동일 경로 read)
    let pkg_frz = fresh_pkg();
    pkg_frz.register("echo", common::echo).unwrap();
    pkg_frz.freeze();
    let echo_id_frz = common::command_id_of(&pkg_frz, "echo");
    let input_frz = common::EchoInput { v: 1 };
    let req_frz = common::postcard_request(echo_id_frz, &input_frz);

    let mut group = c.benchmark_group("dynamic_registry_invoke_read");
    group.sample_size(500);

    group.bench_function(BenchmarkId::new("invoke_rkyv_v2", "mutable"), |b| {
        b.iter(|| {
            let resp = pkg_mut.invoke_rkyv_v2(&req_mut).unwrap();
            let out: common::EchoOutput = common::decode_postcard_response(&resp);
            out
        });
    });

    group.bench_function(BenchmarkId::new("invoke_rkyv_v2", "frozen"), |b| {
        b.iter(|| {
            let resp = pkg_frz.invoke_rkyv_v2(&req_frz).unwrap();
            let out: common::EchoOutput = common::decode_postcard_response(&resp);
            out
        });
    });

    group.finish();
}

criterion_group!(
    benches,
    bench_register,
    bench_live_schema,
    bench_invoke_frozen_vs_mutable
);
criterion_main!(benches);
