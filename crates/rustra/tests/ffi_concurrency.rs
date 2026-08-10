//! FFI 동시성 — `extern "C"` invoke 를 다중 스레드에서 병렬 호출해 OnceLock 글로벌
//! `Package` 의 스레드 안전성을 검증한다. (Task 3.2)
//!
//! `PACKAGE: OnceLock<Package>` 는 변경 불가(immutable) — 빌드 후 고정 — 이므로
//! 병렬 `invoke` 는 `&self` 공유 읽기만 한다. 이 테스트는 그 가정을 증명한다:
//! 응답 누락·교차(cross-correlation)·손상 없이 N 스레드 × M invoke 가 모두 정확해야 한다.
//!
//! 별도 테스트 바이너리(=별도 프로세스)이므로 OnceLock 슬롯을 다른 테스트와 공유하지 않는다.
//! 같은 바이너리 내 모든 테스트는 동일 패키지를 register 하므로 first-wins semantic 도 안전하다.

use rustra::ffi::{rustra_ffi_free, rustra_ffi_invoke_json};
use rustra::Package;
use std::thread;

fn concurrency_package() -> Package {
    Package::builder("concurrency.test")
        .command("addNumbers", |args: serde_json::Value| {
            let a = args["a"].as_i64().unwrap_or(0);
            let b = args["b"].as_i64().unwrap_or(0);
            Ok::<_, rustra::RustraError>(serde_json::json!(a + b))
        })
        .build()
}

/// addNumbers(a,b) 를 JSON FFI 경로로 invoke 하고 result(a+b) 를 반환한다.
/// 버퍼는 반드시 해제한다(free_guard 가드가 활성 상태에서도 정상 경로는 차단되지 않음).
fn invoke_add(a: i64, b: i64) -> i64 {
    let payload = serde_json::to_vec(&serde_json::json!({
        "command": "addNumbers",
        "args": { "a": a, "b": b }
    }))
    .expect("request encodes");
    let mut out_len: usize = 0;
    let ptr = unsafe { rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len) };
    assert!(!ptr.is_null(), "concurrent invoke must return a buffer");
    let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
    let resp: serde_json::Value =
        serde_json::from_slice(bytes).expect("concurrent response must deserialize");
    unsafe { rustra_ffi_free(ptr, out_len) };
    assert_eq!(
        resp["ok"], true,
        "concurrent invoke must succeed, got: {resp}"
    );
    resp["result"]
        .as_i64()
        .expect("result must be an i64 integer")
}

#[test]
fn ffi_invoke_is_safe_under_parallel_load() {
    concurrency_package().register_ffi();
    const THREADS: usize = 8;
    const INVOKES_PER_THREAD: usize = 250;

    let handles: Vec<_> = (0..THREADS)
        .map(|t| {
            thread::spawn(move || {
                let mut failures = 0u32;
                for j in 0..INVOKES_PER_THREAD {
                    // 스레드별로 겹치지 않는 입력 영역 → 응답이 다른 스레드/호출과
                    // 섞이면 즉시 실패.
                    let a = (t as i64) * 1_000_000 + j as i64;
                    let got = invoke_add(a, 1);
                    if got != a + 1 {
                        failures += 1;
                    }
                }
                failures
            })
        })
        .collect();

    let total: u32 = handles
        .into_iter()
        .map(|h| h.join().expect("thread panicked"))
        .sum();
    assert_eq!(
        total, 0,
        "parallel FFI invokes must not corrupt or cross-correlate ({total} failures)"
    );
}

#[test]
fn register_ffi_concurrent_is_idempotent_and_safe() {
    // OnceLock::set 은 first-wins 이므로 병렬 register_ffi 호출이 경쟁해도 패닉/손상 없음.
    // 이후 invoke 가 정상 동작하면 글로벌이 일관됨을 증명.
    const THREADS: usize = 16;
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(THREADS));
    let handles: Vec<_> = (0..THREADS)
        .map(|_| {
            let b = barrier.clone();
            thread::spawn(move || {
                b.wait(); // 모든 스레드가 동시에 register 시도
                concurrency_package().register_ffi();
            })
        })
        .collect();
    for h in handles {
        h.join().expect("register thread panicked");
    }

    // 경쟁 등록 후에도 invoke 가 올바르게 동작한다.
    assert_eq!(invoke_add(40, 2), 42);
}
