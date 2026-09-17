//! Equivalent scalar addition through ordinary functions and legacy commands.
//! Run: cargo bench -p rustra --bench function_dispatch
use criterion::{Criterion, criterion_group, criterion_main};
use rustra::{DirectResponse, Package};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::hint::black_box;
use std::time::Duration;

#[derive(Deserialize, JsonSchema)]
struct AddInput {
    a: i32,
    b: i32,
}
#[derive(Serialize, JsonSchema)]
struct AddOutput {
    value: i32,
}

fn add(a: i32, b: i32) -> i32 {
    a + b
}

fn benchmark(c: &mut Criterion) {
    let package = Package::builder("bench.functionDispatch")
        .function("add", add)
        .command("legacy", |input: AddInput| {
            Ok(AddOutput {
                value: add(input.a, input.b),
            })
        })
        .build();
    // Fixed tuple and struct have the same postcard body, without field names.
    let function_request = [1, 0, 40, 44];
    let legacy_request = [2, 0, 40, 44];
    assert_eq!(
        package.invoke_json("add", json!([20, 22])).unwrap(),
        json!(42)
    );
    assert_eq!(
        package
            .invoke_json("legacy", json!({"a":20,"b":22}))
            .unwrap(),
        json!({"value":42})
    );
    let expected = [1, 0, 0, 0, 0, 0, 0, 0, 84];
    for request in [&function_request, &legacy_request] {
        assert_eq!(package.invoke_frame(request).unwrap(), expected);
        let mut target = [0; 32];
        assert!(matches!(
            package.invoke_frame_into(request, &mut target).unwrap(),
            DirectResponse::Written(9)
        ));
        assert_eq!(&target[..9], &expected);
    }
    let mut group = c.benchmark_group("function_dispatch");
    group.sample_size(100);
    group.warm_up_time(Duration::from_secs(1));
    group.measurement_time(Duration::from_secs(3));
    for (name, request) in [("function", function_request), ("legacy", legacy_request)] {
        group.bench_function(format!("{name}/frame"), |b| {
            b.iter(|| black_box(package.invoke_frame(black_box(&request)).unwrap()))
        });
        let mut target = [0u8; 32];
        group.bench_function(format!("{name}/into"), |b| {
            b.iter(|| {
                black_box(
                    package
                        .invoke_frame_into(black_box(&request), black_box(&mut target))
                        .unwrap(),
                )
            })
        });
    }
    group.bench_function("function/json", |b| {
        b.iter(|| {
            black_box(
                package
                    .invoke_json("add", black_box(json!([20, 22])))
                    .unwrap(),
            )
        })
    });
    group.bench_function("legacy/json", |b| {
        b.iter(|| {
            black_box(
                package
                    .invoke_json("legacy", black_box(json!({"a":20,"b":22})))
                    .unwrap(),
            )
        })
    });
    group.finish();
}

criterion_group!(benches, benchmark);
criterion_main!(benches);
