//! Allocation counts, measured separately from latency (not RSS or peak memory).
//! Run: cargo run -p rustra --release --example codec_allocations
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};

#[path = "../benches/support/complex_cases.rs"]
mod cases;

struct CountingAllocator;
static COUNTING: AtomicBool = AtomicBool::new(false);
static ALLOCATIONS: AtomicU64 = AtomicU64::new(0);
static REQUESTED_BYTES: AtomicU64 = AtomicU64::new(0);

fn record(size: usize) {
    if COUNTING.load(Relaxed) {
        ALLOCATIONS.fetch_add(1, Relaxed);
        REQUESTED_BYTES.fetch_add(size as u64, Relaxed);
    }
}

// SAFETY: all operations forward the original pointer/layout to System. Only
// atomic counters run alongside allocation; they allocate no memory themselves.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        unsafe { System.realloc(ptr, layout, size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn main() {
    let (pkg, cases) = cases::fixtures();
    let mut results = Vec::new();
    const ITERATIONS: u64 = 1000;
    for case in cases {
        for _ in 0..100 {
            std::hint::black_box(pkg.invoke_frame(&case.request).unwrap());
        }
        ALLOCATIONS.store(0, Relaxed);
        REQUESTED_BYTES.store(0, Relaxed);
        COUNTING.store(true, Relaxed);
        for _ in 0..ITERATIONS {
            std::hint::black_box(pkg.invoke_frame(&case.request).unwrap());
        }
        COUNTING.store(false, Relaxed);
        results.push(serde_json::json!({
            "case": case.name,
            "requestBytes": case.request.len(),
            "iterations": ITERATIONS,
            "allocationCalls": ALLOCATIONS.load(Relaxed),
            "requestedBytes": REQUESTED_BYTES.load(Relaxed),
        }));
    }
    println!("{}", serde_json::to_string_pretty(&results).unwrap());
}
