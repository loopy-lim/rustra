//! Separate allocation sampling: total allocation requests, not RSS/peak memory.
use std::alloc::{GlobalAlloc, Layout, System};
use std::hint::black_box;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};

#[path = "../benches/support/tree_cases.rs"]
mod tree_cases;

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

// SAFETY: original pointers/layouts are forwarded to System, and counters do not
// allocate. Reallocation counts its entire requested size, not a retained delta.
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
const ITERATIONS: u64 = 100;

fn measure(mut action: impl FnMut()) -> (u64, u64) {
    for _ in 0..20 {
        action();
    }
    ALLOCATIONS.store(0, Relaxed);
    REQUESTED_BYTES.store(0, Relaxed);
    COUNTING.store(true, Relaxed);
    for _ in 0..ITERATIONS {
        action();
    }
    COUNTING.store(false, Relaxed);
    (ALLOCATIONS.load(Relaxed), REQUESTED_BYTES.load(Relaxed))
}

fn row(
    mode: &str,
    case: &tree_cases::Case,
    request_bytes: usize,
    response_bytes: usize,
    (allocations, requested_bytes): (u64, u64),
) -> serde_json::Value {
    serde_json::json!({
        "case": format!("{mode}/{}", case.name),
        "requestBytes": request_bytes,
        "responseBytes": response_bytes,
        "nodeCount": case.node_count,
        "depth": case.depth,
        "maxFanout": case.max_fanout,
        "iterations": ITERATIONS,
        "allocationCalls": allocations,
        "requestedBytes": requested_bytes,
    })
}

fn main() {
    let (pkg, cases) = tree_cases::fixtures();
    let mut results = Vec::new();
    for case in cases {
        for (mode, request) in [
            ("echo", &case.request),
            ("search", &case.search_request),
            ("resident", &case.resident_request),
        ] {
            let response_bytes = pkg.invoke_frame(request).unwrap().len();
            let counts = measure(|| {
                black_box(pkg.invoke_frame(black_box(request)).unwrap());
            });
            results.push(row(mode, &case, request.len(), response_bytes, counts));
        }
        let counts = measure(|| {
            black_box(tree_cases::search(
                black_box(&case.root),
                black_box(case.target),
            ));
        });
        // The borrowed DFS has no wire request/response and no setup allocation.
        results.push(row("dfs", &case, 0, 0, counts));
    }
    println!("{}", serde_json::to_string_pretty(&results).unwrap());
}
