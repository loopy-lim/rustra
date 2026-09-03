#!/usr/bin/env cargo run -p rustra-calculator-example --bin wire-bench --release --
//! 와이어포맷(직렬화) 계층 벤치마크 — JSON vs postcard vs rkyv V2.
//!
//! 목적: 같은 addNumbers(42, 58) 호출을 각 와이어포맷 경로로 N 회 직접 호출해
//! 순수 직렬화+디스패치+역직렬화 비용을 측정한다. JS↔FFI 경계 노이즈가
//! 제외된 코어 수치다. 과거에는 예제 전용 legacy C 심볼
//! (`rustra_calculator_invoke*`) 을 통해 측정했지만, legacy 프로토콜 제거
//! 이후에는 `Package` 공개 메서드를 직접 호출한다 — 측정 의미(동일 페이로드,
//! 동일 디스패치)는 동일하다.
//!
//! 페이로드:
//!   JSON     : invoke_json("addNumbers", {a:42,b:58})      (serde_json)
//!   postcard : [cmd_id u16 LE][postcard AddNumbersInput]   (복사 반환 경로)
//!   rkyv V2  : 동일 페이로드, caller-buffer 경로(invoke_rkyv_v2_into)
//!
//! postcard 와 rkyv V2 가 같은 와이어를 쓰는 이유: 두 경로의 차이는
//! "응답을 새 Vec 으로 복사해 돌려주느냐(zero-copy access + caller buffer)"
//! 이고, 이 차이가 곧 비교 대상이다.
//!
//! 실행: cargo run -p rustra-calculator-example --bin wire-bench --release

use rustra_calculator_example::{AddNumbersInput, calculator_package};
use rustra::DirectResponse;

fn percentile(sorted: &[f64], pct: f64) -> f64 {
    let idx = ((pct / 100.0) * sorted.len() as f64).floor() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn fmt_ns(ns: f64) -> String {
    if ns >= 1_000.0 {
        format!("{:.2} µs", ns / 1_000.0)
    } else {
        format!("{:.1} ns", ns)
    }
}

struct Result {
    name: &'static str,
    req_bytes: usize,
    resp_bytes: usize,
    avg: f64,
    p50: f64,
    p99: f64,
    ops: f64,
}

fn bench(
    name: &'static str,
    req_bytes: usize,
    iters: usize,
    mut call: impl FnMut() -> usize, // returns response byte count
) -> Result {
    // warmup
    for _ in 0..2_000 {
        let _ = call();
    }
    let mut times: Vec<f64> = Vec::with_capacity(iters);
    let mut last_resp = 0;
    for _ in 0..iters {
        let t = std::time::Instant::now();
        last_resp = call();
        times.push(t.elapsed().as_nanos() as f64);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let avg = times.iter().sum::<f64>() / iters as f64;
    let p50 = percentile(&times, 50.0);
    let p99 = percentile(&times, 99.0);
    let ops = 1_000_000_000.0 / avg;
    Result {
        name,
        req_bytes,
        resp_bytes: last_resp,
        avg,
        p50,
        p99,
        ops,
    }
}

fn main() {
    let package = calculator_package();

    let iters = 100_000;
    println!();
    println!("┌─ Wire-format Benchmark (addNumbers 42+58, {iters} iters, release) ─┐");
    println!("│  Apple Silicon / Rust core cost (직렬화+디스패치+역직렬화)");
    println!("└──────────────────────────────────────────────────────────────────────┘");
    println!();

    // addNumbers cmd_id 는 등록 순서 계약(register! 순서)에 따라 1 이지만,
    // 하드코딩 대신 역방향 조회로 얻는다 — 신규 커맨드 추가로 id 가 시프트돼도
    // 벤치가 무관하게 유지된다.
    let cmd_id = (1u16..)
        .find(|id| package.resolve_command_id(*id).as_deref() == Some("addNumbers"))
        .expect("addNumbers registered");

    // ── JSON ─────────────────────────────────────────────────────────
    let args = serde_json::json!({ "a": 42, "b": 58 });
    let r_json = bench("JSON (invoke_json)", 47, iters, || {
        let value = package
            .invoke_json("addNumbers", args.clone())
            .expect("addNumbers succeeds");
        serde_json::to_vec(&value).unwrap().len()
    });

    // ── postcard / rkyv V2 ───────────────────────────────────────────
    // 동일 요청 와이어: [cmd_id u16 LE][postcard AddNumbersInput{a:42,b:58}]
    let input = AddNumbersInput { a: 42, b: 58 };
    let input_bytes = postcard::to_allocvec(&input).unwrap();
    let mut req = Vec::with_capacity(2 + input_bytes.len());
    req.extend_from_slice(&cmd_id.to_le_bytes());
    req.extend_from_slice(&input_bytes);
    let req_len = req.len();

    let r_pc = bench("postcard (invoke_rkyv_v2)", req_len, iters, || {
        package.invoke_rkyv_v2(&req).expect("ok").len()
    });

    let mut out_buf = vec![0u8; 256];
    let r_rkyv = bench("rkyv V2 (invoke_rkyv_v2_into)", req_len, iters, || {
        match package
            .invoke_rkyv_v2_into(&req, &mut out_buf)
            .expect("ok")
        {
            DirectResponse::Written(n) => n,
            DirectResponse::Buffered(bytes) => bytes.len(),
        }
    });

    // ── 출력 ─────────────────────────────────────────────────────────
    let results = [r_json, r_pc, r_rkyv];
    let max_avg = results.iter().map(|r| r.avg).fold(0.0_f64, f64::max);

    println!(
        "│  {:<26} {:>6} {:>6} {:>10} {:>10} {:>10} {:>12}",
        "포맷", "요청", "응답", "avg", "p50", "p99", "ops/s"
    );
    println!("│  {}", "─".repeat(88));
    for r in &results {
        println!(
            "│  {:<26} {:>5}B {:>5}B {:>10} {:>10} {:>10} {:>12.0}",
            r.name,
            r.req_bytes,
            r.resp_bytes,
            fmt_ns(r.avg),
            fmt_ns(r.p50),
            fmt_ns(r.p99),
            r.ops
        );
    }
    println!("│");
    println!("│  평균 호출 비용 (낮을수록 빠름):");
    for r in &results {
        let filled = ((r.avg / max_avg) * 35.0).round() as usize;
        let bar = "█".repeat(filled.max(1)) + &"░".repeat(35 - filled.min(35));
        println!("│  {:<26} {} {}", r.name, bar, fmt_ns(r.avg));
    }
    println!("│");
    println!("│  와이어 크기 (요청/응답, JSON 기준 배율):");
    let json_req = results[0].req_bytes as f64;
    let json_resp = results[0].resp_bytes as f64;
    for r in &results {
        println!(
            "│  {:<26} 요청 {:>3}B ({:.1}x)  응답 {:>3}B ({:.1}x)",
            r.name,
            r.req_bytes,
            r.req_bytes as f64 / json_req,
            r.resp_bytes,
            r.resp_bytes as f64 / json_resp,
        );
    }
    println!();
}
