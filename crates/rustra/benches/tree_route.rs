//! Full tree round trip, last-node request, and borrowed in-memory DFS baseline.
use std::hint::black_box;

use criterion::{BenchmarkId, Criterion, criterion_group, criterion_main};

#[path = "support/tree_cases.rs"]
mod tree_cases;

fn bench_tree_route(c: &mut Criterion) {
    let (pkg, cases) = tree_cases::fixtures();
    let mut group = c.benchmark_group("tree_route");
    group.sample_size(100);
    for case in cases {
        group.bench_function(BenchmarkId::new("echo", case.name), |b| {
            b.iter(|| black_box(pkg.invoke_frame(black_box(&case.request)).unwrap()));
        });
        group.bench_function(BenchmarkId::new("search", case.name), |b| {
            b.iter(|| black_box(pkg.invoke_frame(black_box(&case.search_request)).unwrap()));
        });
        group.bench_function(BenchmarkId::new("resident", case.name), |b| {
            b.iter(|| black_box(pkg.invoke_frame(black_box(&case.resident_request)).unwrap()));
        });
        group.bench_function(BenchmarkId::new("dfs", case.name), |b| {
            b.iter(|| {
                black_box(tree_cases::search(
                    black_box(&case.root),
                    black_box(case.target),
                ))
            });
        });
    }
    group.finish();
}

criterion_group!(benches, bench_tree_route);
criterion_main!(benches);
