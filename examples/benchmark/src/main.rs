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
    bench_parallel_invocation(&package);
    bench_memory_usage(&package);
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

/// 실제 병렬 invoke — N 스레드 × iterations. `Package::invoke` 는 내부 레지스트리가
/// RwLock 공유되므로 읽기 경합이 실측된다 (안전성은 tests/rkyv_v2_concurrency.rs 가
/// 증명, 여기선 성능만).
fn bench_parallel_invocation(package: &rustra::Package) {
    println!("┌─ Throughput (multi-threaded, std::thread::scope) ───────┐");

    for thread_count in [2usize, 4, 8] {
        let iterations_per_thread = 125_000;
        let start = Instant::now();

        std::thread::scope(|scope| {
            for _ in 0..thread_count {
                scope.spawn(move || {
                    let input = SimpleInput { a: 42, b: 58 };
                    for _ in 0..iterations_per_thread {
                        let _: Result<SimpleOutput> = package.invoke("addNumbers", input.clone());
                    }
                });
            }
        });

        let elapsed = start.elapsed();
        let total = (iterations_per_thread * thread_count) as f64;
        let ops_per_sec = total / elapsed.as_secs_f64();
        println!(
            "│  {thread_count} threads × {iterations_per_thread}: {elapsed:.2?} — {}",
            format_ops(ops_per_sec)
        );
    }

    println!("└─────────────────────────────────────────────────────────┘");
    println!();
}

/// 메모리 사용량 — invoke 와이어 할당 관점의 근사 측정.
/// 의존성 없이 /proc 또는 mach API 대신, 할당 크기를 직렬화 결과 크기로 환산하는
/// Rust 표준만으로 측정한다: payload별 직렬화 버퍼 크기 + invoke 전후 프로세스 RSS.
fn bench_memory_usage(package: &rustra::Package) {
    println!("┌─ Memory (wire size + RSS delta) ────────────────────────┐");

    // 1) payload 크기별 직렬화 버퍼 크기 — 와이어 예산.
    for item_count in [1usize, 10, 100, 1000] {
        let items: Vec<Item> = (0..item_count)
            .map(|i| Item {
                id: i as i64,
                name: format!("item-{i}"),
                tags: vec![format!("tag-{i}")],
                active: true,
                score: i as f64,
            })
            .collect();
        let input = PayloadInput { items };
        let json = serde_json::to_vec(&input).expect("serialize");
        let out: Result<PayloadOutput> = package.invoke("processPayload", input);
        let _ = out;
        println!("│  items={item_count:>5}: JSON wire {} bytes", json.len());
    }

    // 2) 대량 invoke 전후 RSS — macOS/Unix 공통 근사 (rustc std 만 사용).
    //    RSS 측정이 불가한 플랫폼은 스킵 (정직).
    if let Some(before) = current_rss_bytes() {
        let input = SimpleInput { a: 1, b: 2 };
        for _ in 0..100_000 {
            let _: Result<SimpleOutput> = package.invoke("addNumbers", input.clone());
        }
        if let Some(after) = current_rss_bytes() {
            println!(
                "│  RSS after 100k invokes: {before} → {after} bytes (delta {})",
                after.saturating_sub(before)
            );
        }
    }

    println!("└─────────────────────────────────────────────────────────┘");
    println!();
    print_summary_separator();
}

/// 프로세스 RSS 바이트 — macOS (mach) 우선, 실패 시 None.
fn current_rss_bytes() -> Option<u64> {
    #[cfg(target_os = "macos")]
    {
        // PAGE_SIZE * resident_page_count via mach_task_basic_info.
        unsafe extern "C" {
            fn mach_task_self() -> u32;
            fn task_info(
                target_task: u32,
                flavor: u32,
                task_info_out: *mut u8,
                task_info_out_count: *mut u32,
            ) -> i32;
        }
        #[repr(C)]
        struct TaskBasicInfo {
            suspend_count: i32,
            virtual_size: u64,
            resident_size: u64,
            user_time: u64,
            system_time: u64,
            policy: i32,
        }
        const MACH_TASK_BASIC_INFO: u32 = 20;
        let mut info = unsafe { std::mem::zeroed::<TaskBasicInfo>() };
        let mut count = (std::mem::size_of::<TaskBasicInfo>() / std::mem::size_of::<u32>()) as u32;
        let kr = unsafe {
            task_info(
                mach_task_self(),
                MACH_TASK_BASIC_INFO,
                &mut info as *mut TaskBasicInfo as *mut u8,
                &mut count,
            )
        };
        if kr == 0 {
            Some(info.resident_size)
        } else {
            None
        }
    }
    #[cfg(target_os = "linux")]
    {
        // /proc/self/statm 의 두 번째 필드가 RSS 페이지 수 — 페이지 크기를 곱해 바이트로.
        // statm [0]=VSS [1]=RSS [2]=shared … (proc(5) 참고).
        let Ok(statm) = std::fs::read_to_string("/proc/self/statm") else {
            return None;
        };
        let fields: Vec<&str> = statm.split_whitespace().collect();
        let rss_pages: u64 = fields.get(1)?.parse().ok()?;
        let page_size = 4096u64; // 대부분의 Linux 페이지 크기 — sysconf 없이 고정.
        Some(rss_pages * page_size)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    None
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
