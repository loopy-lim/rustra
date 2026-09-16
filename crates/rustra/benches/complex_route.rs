//! Production-profile complex codec latency at the Package::invoke_frame boundary.
//! Run: cargo bench -p rustra --bench complex_route
use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};

#[path = "support/complex_cases.rs"]
mod cases;

fn bench_complex_route(c: &mut Criterion) {
    let (pkg, cases) = cases::fixtures();
    let mut group = c.benchmark_group("complex_route");
    group.sample_size(500);
    for case in cases {
        group.bench_function(BenchmarkId::new("invoke_frame", case.name), |b| {
            b.iter(|| std::hint::black_box(pkg.invoke_frame(&case.request).unwrap()));
        });
    }
    group.finish();
}

criterion_group!(benches, bench_complex_route);
criterion_main!(benches);
