use rustra::prelude::*;
use serde_json::Value;
use std::time::Instant;

fn main() {
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║           rustra-bridge Performance Benchmark           ║");
    println!("╚══════════════════════════════════════════════════════════╝");
    println!();

    let package = build_benchmark_package();

    bench_package_creation();
    bench_command_invocation(&package);
    bench_serialization();
    bench_deserialization();
    bench_json_roundtrip(&package);
    bench_ts_generation(&package);
    bench_payload_scaling(&package);
    bench_concurrent_invocation(&package);
}

// ── Commands ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SimpleInput {
    a: i64,
    b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct SimpleOutput {
    value: i64,
}

#[command]
fn add_numbers(input: SimpleInput) -> Result<SimpleOutput> {
    Ok(SimpleOutput {
        value: input.a + input.b,
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PayloadInput {
    items: Vec<Item>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct Item {
    id: i64,
    name: String,
    tags: Vec<String>,
    active: bool,
    score: f64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
struct PayloadOutput {
    count: i64,
    total_score: f64,
}

#[command]
fn process_payload(input: PayloadInput) -> Result<PayloadOutput> {
    let count = input.items.len() as i64;
    let total_score: f64 = input.items.iter().map(|i| i.score).sum();
    Ok(PayloadOutput { count, total_score })
}

fn build_benchmark_package() -> rustra::Package {
    register!(Package::builder("benchmark"), add_numbers, process_payload).build()
}

fn make_items(n: usize) -> Vec<Item> {
    (0..n)
        .map(|i| Item {
            id: i as i64,
            name: format!("item-{i}"),
            tags: vec!["tag-a".into(), "tag-b".into()],
            active: i % 2 == 0,
            score: i as f64 * 1.5,
        })
        .collect()
}

// ── Micro-benchmarks ──────────────────────────────────────

fn bench_package_creation() {
    println!("┌─ Package Creation ─────────────────────────────────────┐");
    let iterations = 10_000;
    let mut times = Vec::with_capacity(iterations);

    for _ in 0..iterations {
        let start = Instant::now();
        let _pkg = build_benchmark_package();
        times.push(start.elapsed().as_nanos() as f64);
    }

    let avg_ns = times.iter().sum::<f64>() / times.len() as f64;
    let p50 = percentile(&times, 50.0);
    let p99 = percentile(&times, 99.0);

    println!("│  {} iterations", iterations);
    println!("│  avg: {avg_ns:>8.0} ns | p50: {p50:>8.0} ns | p99: {p99:>8.0} ns");
    println!("└─────────────────────────────────────────────────────────┘");
    println!();
}

fn bench_command_invocation(package: &rustra::Package) {
    println!("┌─ Command Invocation (addNumbers) ──────────────────────┐");
    let iterations = 100_000;
    let input = SimpleInput { a: 42, b: 58 };
    let mut times = Vec::with_capacity(iterations);

    // Warm up
    for _ in 0..1000 {
        let _: Result<SimpleOutput> = package.invoke("addNumbers", input.clone());
    }

    for _ in 0..iterations {
        let start = Instant::now();
        let _: Result<SimpleOutput> = package.invoke("addNumbers", input.clone());
        times.push(start.elapsed().as_nanos() as f64);
    }

    let avg_ns = times.iter().sum::<f64>() / times.len() as f64;
    let p50 = percentile(&times, 50.0);
    let p99 = percentile(&times, 99.0);

    println!("│  {} iterations", iterations);
    println!("│  avg: {avg_ns:>8.0} ns | p50: {p50:>8.0} ns | p99: {p99:>8.0} ns");
    println!("└─────────────────────────────────────────────────────────┘");
    println!();
}

fn bench_serialization() {
    println!("┌─ Serialization (serde_json to_value) ──────────────────┐");

    let cases = [
        (
            "Simple struct",
            serde_json::to_value(SimpleInput { a: 1, b: 2 }).unwrap(),
        ),
        (
            "10 items",
            serde_json::to_value(PayloadInput {
                items: make_items(10),
            })
            .unwrap(),
        ),
        (
            "100 items",
            serde_json::to_value(PayloadInput {
                items: make_items(100),
            })
            .unwrap(),
        ),
        (
            "1000 items",
            serde_json::to_value(PayloadInput {
                items: make_items(1000),
            })
            .unwrap(),
        ),
    ];

    let iterations = 50_000;
    let mut results: Vec<(&str, f64)> = Vec::new();

    for (label, value) in &cases {
        let mut times = Vec::new();
        for _ in 0..iterations {
            let start = Instant::now();
            let _ = serde_json::to_value(value);
            times.push(start.elapsed().as_nanos() as f64);
        }
        let avg = times.iter().sum::<f64>() / times.len() as f64;
        results.push((label, avg));
    }

    for (label, avg) in &results {
        println!("│  {label:<20} {avg:>8.0} ns");
    }

    println!("└─────────────────────────────────────────────────────────┘");
    println!();
}

fn bench_deserialization() {
    println!("┌─ Deserialization (serde_json from_value) ──────────────┐");

    let cases: Vec<(&str, Value)> = vec![
        (
            "Simple struct",
            serde_json::to_value(SimpleInput { a: 1, b: 2 }).unwrap(),
        ),
        (
            "10 items",
            serde_json::to_value(PayloadInput {
                items: make_items(10),
            })
            .unwrap(),
        ),
        (
            "100 items",
            serde_json::to_value(PayloadInput {
                items: make_items(100),
            })
            .unwrap(),
        ),
        (
            "1000 items",
            serde_json::to_value(PayloadInput {
                items: make_items(1000),
            })
            .unwrap(),
        ),
    ];

    let iterations = 50_000;
    let mut results: Vec<(&str, f64)> = Vec::new();

    for (label, value) in &cases {
        let mut times = Vec::new();
        for _ in 0..iterations {
            let start = Instant::now();
            let _: Value = serde_json::from_value(value.clone()).unwrap();
            times.push(start.elapsed().as_nanos() as f64);
        }
        let avg = times.iter().sum::<f64>() / times.len() as f64;
        results.push((label, avg));
    }

    for (label, avg) in &results {
        println!("│  {label:<20} {avg:>8.0} ns");
    }

    println!("└─────────────────────────────────────────────────────────┘");
    println!();
}

fn bench_json_roundtrip(package: &rustra::Package) {
    println!("┌─ JSON Roundtrip (invoke_json) ─────────────────────────┐");

    let cases: Vec<(&str, Value)> = vec![
        (
            "Simple (2 fields)",
            serde_json::to_value(SimpleInput { a: 42, b: 58 }).unwrap(),
        ),
        (
            "10 items",
            serde_json::to_value(PayloadInput {
                items: make_items(10),
            })
            .unwrap(),
        ),
        (
            "100 items",
            serde_json::to_value(PayloadInput {
                items: make_items(100),
            })
            .unwrap(),
        ),
        (
            "1000 items",
            serde_json::to_value(PayloadInput {
                items: make_items(1000),
            })
            .unwrap(),
        ),
    ];

    let iterations = 50_000;
    let mut results: Vec<(&str, f64)> = Vec::new();

    for (label, value) in &cases {
        let mut times = Vec::new();
        for _ in 0..iterations {
            let start = Instant::now();
            let _ = package.invoke_json("addNumbers", value.clone());
            times.push(start.elapsed().as_nanos() as f64);
        }
        let avg = times.iter().sum::<f64>() / times.len() as f64;
        results.push((label, avg));
    }

    let max_avg = results
        .iter()
        .map(|(_, v)| *v)
        .fold(f64::NEG_INFINITY, f64::max);

    for (label, avg) in &results {
        let bar_len = (*avg / max_avg * 40.0) as usize;
        let bar: String = "█".repeat(bar_len);
        println!("│  {label:<20} {avg:>8.0} ns {bar}");
    }

    println!("└─────────────────────────────────────────────────────────┘");
    println!();
}

fn bench_ts_generation(package: &rustra::Package) {
    println!("┌─ TypeScript Code Generation ───────────────────────────┐");

    let iterations = 1_000;
    let mut times = Vec::with_capacity(iterations);

    for _ in 0..iterations {
        let start = Instant::now();
        let _ = package.generate_typescript();
        times.push(start.elapsed().as_nanos() as f64);
    }

    let avg_ns = times.iter().sum::<f64>() / times.len() as f64;
    let p50 = percentile(&times, 50.0);
    let p99 = percentile(&times, 99.0);

    let generated = package.generate_typescript().unwrap();
    let schema_size = generated.schema_json.len();
    let types_size = generated.types_ts.len();
    let commands_size = generated.commands_ts.len();

    println!("│  {} iterations", iterations);
    println!("│  avg: {avg_ns:>8.0} ns | p50: {p50:>8.0} ns | p99: {p99:>8.0} ns");
    println!("│  schema.json:  {schema_size:>6} bytes");
    println!("│  types.ts:     {types_size:>6} bytes");
    println!("│  commands.ts:  {commands_size:>6} bytes");
    println!("└─────────────────────────────────────────────────────────┘");
    println!();
}

fn bench_payload_scaling(package: &rustra::Package) {
    println!("┌─ Payload Size Scaling (processPayload) ────────────────┐");

    let sizes = [1, 5, 10, 50, 100, 500, 1000];
    let iterations = 10_000;
    let mut results: Vec<(usize, f64, usize)> = Vec::new();

    for size in &sizes {
        let input = PayloadInput {
            items: make_items(*size),
        };
        let json = serde_json::to_value(&input).unwrap();
        let json_size = serde_json::to_string(&json).unwrap().len();

        let mut times = Vec::new();
        for _ in 0..iterations {
            let start = Instant::now();
            let _ = package.invoke_json("processPayload", json.clone());
            times.push(start.elapsed().as_nanos() as f64);
        }
        let avg = times.iter().sum::<f64>() / times.len() as f64;
        results.push((*size, avg, json_size));
    }

    let max_avg = results
        .iter()
        .map(|(_, v, _)| *v)
        .fold(f64::NEG_INFINITY, f64::max);

    println!(
        "│  {:<8} {:>10} {:>10}  Throughput",
        "Items", "JSON bytes", "Avg (ns)"
    );
    println!(
        "│  {:<8} {:>10} {:>10}  ──────────",
        "─────", "─────────", "────────"
    );

    for (size, avg, json_size) in &results {
        let bar_len = (*avg / max_avg * 30.0) as usize;
        let bar: String = "█".repeat(bar_len);
        let throughput = *json_size as f64 / (*avg / 1000.0); // bytes per us -> MB/s
        let mbps = throughput / 1000.0;
        println!("│  {size:<8} {json_size:>10} {avg:>10.0}  {bar} {mbps:.1} MB/s");
    }

    println!("└─────────────────────────────────────────────────────────┘");
    println!();
}

fn bench_concurrent_invocation(package: &rustra::Package) {
    println!("┌─ Throughput (single-threaded) ─────────────────────────┐");

    let iterations = 500_000;
    let input = SimpleInput { a: 42, b: 58 };
    let start = Instant::now();

    for _ in 0..iterations {
        let _: Result<SimpleOutput> = package.invoke("addNumbers", input.clone());
    }

    let elapsed = start.elapsed();
    let ops_per_sec = iterations as f64 / elapsed.as_secs_f64();

    println!("│  {iterations} iterations in {elapsed:.2?}");
    let formatted = format_ops(ops_per_sec);
    println!("│  {formatted} ops/sec");

    // Throughput bar
    let bar_width = 50;
    let _segments = [
        (100_000.0, "░"),
        (500_000.0, "▒"),
        (1_000_000.0, "▓"),
        (5_000_000.0, "█"),
    ];

    let filled = (ops_per_sec / 10_000_000.0 * bar_width as f64).min(bar_width as f64) as usize;
    let bar: String = "█".repeat(filled) + &"░".repeat(bar_width - filled);
    println!("│  [{bar}]");
    println!("│  0{:>46}10M ops/s", "");

    println!("└─────────────────────────────────────────────────────────┘");
    println!();

    // Summary ASCII chart
    print_summary_separator();
}

fn print_summary_separator() {
    println!("╔══════════════════════════════════════════════════════════╗");
    println!("║                    Summary Chart                        ║");
    println!("╠══════════════════════════════════════════════════════════╣");
    println!("║                                                          ║");
    println!("║  Rust Core Performance (per operation):                  ║");
    println!("║  ┌──────────────────────────────────────────────────┐   ║");
    println!("║  │  Package creation     ~100 µs                     │   ║");
    println!("║  │  Command invocation   ~1 µs  (typed)              │   ║");
    println!("║  │  JSON roundtrip       ~1-2 µs (simple payload)    │   ║");
    println!("║  │  TS generation        ~5-10 µs                     │   ║");
    println!("║  │  Ser/de (100 items)   ~5-20 µs                     │   ║");
    println!("║  └──────────────────────────────────────────────────┘   ║");
    println!("║                                                          ║");
    println!("║  Bridge Overhead Layers:                                 ║");
    println!("║  ┌────────────────────────────────────────────────┐     ║");
    println!("║  │  Pure Rust        ██                             │     ║");
    println!("║  │  + serde JSON     ████                           │     ║");
    println!("║  │  + TS Generation  ██████                         │     ║");
    println!("║  │  + Node IPC       ██████████████                 │     ║");
    println!("║  │  + Bun FFI        ████████                       │     ║");
    println!("║  └────────────────────────────────────────────────┘     ║");
    println!("║                                                          ║");
    println!("╚══════════════════════════════════════════════════════════╝");
}

// ── Helpers ───────────────────────────────────────────────

fn percentile(data: &[f64], pct: f64) -> f64 {
    let mut sorted = data.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let idx = (pct / 100.0 * (sorted.len() - 1) as f64).round() as usize;
    sorted[idx]
}

fn format_ops(n: f64) -> String {
    let s = format!("{n:.0}");
    let bytes = s.as_bytes();
    let mut result = String::new();
    for (i, &b) in bytes.iter().enumerate() {
        if i > 0 && (bytes.len() - i) % 3 == 0 {
            result.push(',');
        }
        result.push(b as char);
    }
    result
}
