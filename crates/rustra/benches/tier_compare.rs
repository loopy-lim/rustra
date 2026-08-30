//! Tier 비교 벤치마크 — 동일 의미 연산(echo: `{"v":7}`)을 wire 만 바꿔 측정한다.
//!
//! 기존 구성(add/greet/echo 혼합)은 "연산 효과 + wire 효과"가 섞여 있어
//! 6.55x 같은 수치를 wire 차이로 오독하기 쉬웠다. 이 벤치는 연산을 통제해
//! wire 차이만 남긴다:
//!
//! (a) 정적 postcard — 빌더로 등록된 `echo` (rkyv V2 postcard fast-path)
//! (b) 동적 postcard — 런타임 `register` 로 등록된 `echo_dyn` (T2-1: 지원
//!     스키마 동적 명령도 postcard 핸들러를 받는다)
//! (c) 동적 Tier 3 JSON — 런타임 `register` 로 등록된 `echo_any` (anyOf 3항
//!     untagged — postcard/complex 둘 다 거부 → JSON-in-binary 유지)
//!
//! 실행: `cargo bench -p rustra --bench tier_compare --profile dev`
//! (동적 경로는 register 로만 도달 → debug 빌드 필수. 동적 명령은 dev-only 설계.)
//! 정적 절대 수치 비교선이 필요하면 release 정적 벤치와 병기한다 — 동적 수치는
//! dev 빌드에서 나온 것이므로 release 수치와 직접 비교하면 안 된다.

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};
use rustra::Package;

#[path = "common.rs"]
mod common;

fn build_pkg() -> Package {
    // 정적 echo (postcard 핸들러) — 연산은 동적 echo_dyn 과 동일 (v: i64 echo).
    let pkg = Package::builder("bench.tier_compare")
        .command("echo", common::echo)
        .build();
    // 동적 echo_dyn — 동일 타입을 런타임 register 로 등록. (T2-1) EchoIn{v:i64}
    // 는 postcard 지원 형태라 동적 등록이라도 postcard 핸들러를 받는다.
    pkg.register("echo_dyn", common::echo)
        .expect("register must work in debug build");
    // 동적 echo_any — anyOf 3항 untagged(Untagged3Value)는 postcard/complex
    // 둘 다 거부 → Tier 3 JSON 핸들러 유지 (runtime_registry_tests 계약).
    pkg.register("echo_any", common::any_value)
        .expect("register must work in debug build");
    pkg
}

fn bench_tier_compare(c: &mut Criterion) {
    let pkg = build_pkg();

    let static_id = common::command_id_of(&pkg, "echo");
    let dynamic_id = common::command_id_of(&pkg, "echo_dyn");
    let tier3_id = common::command_id_of(&pkg, "echo_any");

    // 동일 의미 연산, 동일 페이로드 {"v":7} — wire 만 다르다.
    let static_req = common::postcard_request(static_id, &common::EchoInput { v: 7 });
    let dynamic_req = common::postcard_request(dynamic_id, &common::EchoInput { v: 7 });
    let tier3_req = common::tier3_request(tier3_id, r#"{"v":"text7"}"#);

    let mut group = c.benchmark_group("tier_compare");
    group.sample_size(500);

    group.bench_function(BenchmarkId::new("echo", "static_postcard"), |b| {
        b.iter(|| {
            let resp = pkg.invoke_rkyv_v2(&static_req).unwrap();
            let out: common::EchoOutput = common::decode_postcard_response(&resp);
            out
        });
    });

    group.bench_function(BenchmarkId::new("echo", "dynamic_postcard"), |b| {
        b.iter(|| {
            let resp = pkg.invoke_rkyv_v2(&dynamic_req).unwrap();
            let out: common::EchoOutput = common::decode_postcard_response(&resp);
            out
        });
    });

    group.bench_function(BenchmarkId::new("echo", "dynamic_tier3_json"), |b| {
        b.iter(|| {
            let resp = pkg.invoke_rkyv_v2(&tier3_req).unwrap();
            common::decode_tier3_response(&resp)
        });
    });

    group.finish();
}

criterion_group!(benches, bench_tier_compare);
criterion_main!(benches);
