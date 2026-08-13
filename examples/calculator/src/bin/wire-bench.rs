#!/usr/bin/env cargo run -p rustra-calculator-example --bin wire-bench --release --
//! 와이어포맷(직렬화) 계층 벤치마크 — JSON vs postcard vs rkyv V2.
//!
//! 목적: 같은 addNumbers(42, 58) 호출을 각 와이어포맷의 FFI 심볼로 N 회 직접 호출해
//! 순수 직렬화+디스패치+역직렬화 비용을 측정한다. JS↔FFI 경계 노이즈가 제외된 코어 수치.
//!
//! 페이로드:
//!   JSON     : {"command":"addNumbers","args":{"a":42,"b":58}}  (null-terminated)
//!   postcard : BincodeRequest{command,a,b} postcard 직렬화
//!   rkyv V2  : [cmd_id u16 LE=1][postcard AddNumbersInput{a,b}]   (fast-path)
//!
//! 실행: cargo run -p rustra-calculator-example --bin wire-bench --release

use rustra_calculator_example::{
    rustra_calculator_free_buffer, rustra_calculator_free_string, rustra_calculator_init,
    rustra_calculator_invoke, rustra_calculator_invoke_postcard, rustra_calculator_invoke_rkyv_v2,
    AddNumbersInput,
};
use serde::{Deserialize, Serialize};

// lib 의 (private) BincodeRequest 와 동일 레이아웃 — postcard 바이트 호환.
#[derive(Serialize, Deserialize)]
struct BenchReq {
    command: String,
    a: i64,
    b: i64,
}

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
    // Apple 은 __mod_init_func 가 자동 등록하지만 명시 호출(크로스플랫폼 안전).
    rustra_calculator_init();

    let iters = 100_000;
    println!();
    println!("┌─ Wire-format Benchmark (addNumbers 42+58, {iters} iters, release) ─┐");
    println!("│  Apple Silicon / Rust core cost (직렬화+디스패치+역직렬화)");
    println!("└──────────────────────────────────────────────────────────────────────┘");
    println!();

    // ── JSON ─────────────────────────────────────────────────────────
    let json = std::ffi::CString::new(r#"{"command":"addNumbers","args":{"a":42,"b":58}}"#).unwrap();
    let json_req_len = json.as_bytes().len();
    let r_json = bench("JSON (invoke)", json_req_len, iters, || {
        let ptr = unsafe { rustra_calculator_invoke(json.as_ptr()) };
        // 응답 길이 = strlen
        let len = unsafe {
            let mut n = 0usize;
            while *ptr.add(n) != 0 {
                n += 1;
            }
            n
        };
        unsafe { rustra_calculator_free_string(ptr) };
        len
    });

    // ── postcard ─────────────────────────────────────────────────────
    let req = BenchReq {
        command: "addNumbers".into(),
        a: 42,
        b: 58,
    };
    let pc = postcard::to_allocvec(&req).unwrap();
    let pc_req_len = pc.len();
    let mut pc_out: usize = 0;
    let r_pc = bench("postcard (invoke_postcard)", pc_req_len, iters, || {
        let ptr = unsafe { rustra_calculator_invoke_postcard(pc.as_ptr(), pc.len(), &mut pc_out) };
        let n = pc_out;
        unsafe { rustra_calculator_free_buffer(ptr, pc_out) };
        n
    });

    // ── rkyv V2 fast-path ────────────────────────────────────────────
    // [cmd_id u16 LE=1][postcard AddNumbersInput{a:42,b:58}]
    let mut rkyv: Vec<u8> = Vec::with_capacity(16);
    rkyv.extend_from_slice(&1u16.to_le_bytes()); // addNumbers cmd_id = 1
    let input = AddNumbersInput { a: 42, b: 58 };
    rkyv.extend_from_slice(&postcard::to_allocvec(&input).unwrap());
    let rkyv_req_len = rkyv.len();
    let mut rkyv_out: usize = 0;
    let r_rkyv = bench("rkyv V2 (invoke_rkyv_v2)", rkyv_req_len, iters, || {
        let ptr =
            unsafe { rustra_calculator_invoke_rkyv_v2(rkyv.as_ptr(), rkyv.len(), &mut rkyv_out) };
        let n = rkyv_out;
        unsafe { rustra_calculator_free_buffer(ptr, rkyv_out) };
        n
    });

    // ── 출력 ─────────────────────────────────────────────────────────
    let results = [r_json, r_pc, r_rkyv];
    let max_avg = results.iter().map(|r| r.avg).fold(0.0_f64, f64::max);

    println!("│  {:<26} {:>6} {:>6} {:>10} {:>10} {:>10} {:>12}", "포맷", "요청", "응답", "avg", "p50", "p99", "ops/s");
    println!("│  {}", "─".repeat(88));
    for r in &results {
        println!(
            "│  {:<26} {:>5}B {:>5}B {:>10} {:>10} {:>10} {:>12.0}",
            r.name, r.req_bytes, r.resp_bytes, fmt_ns(r.avg), fmt_ns(r.p50), fmt_ns(r.p99), r.ops
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
