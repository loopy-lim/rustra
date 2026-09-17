//! Test-only allocator instrumentation; no production allocator or ABI changes.
use rustra::{DirectResponse, Package};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::atomic::{AtomicUsize, Ordering};

struct CountingAllocator;
thread_local! {
    static COUNTING: Cell<bool> = const { Cell::new(false) };
    static ALLOCATIONS: Cell<usize> = const { Cell::new(0) };
}
fn count() {
    if COUNTING.try_with(Cell::get).unwrap_or(false) {
        let _ = ALLOCATIONS.try_with(|value| value.set(value.get() + 1));
    }
}
// SAFETY: every operation delegates the original pointer/layout to System.
// Instrumentation only increments initialized, thread-local counters.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        count();
        // SAFETY: the caller supplies the GlobalAlloc layout contract.
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        count();
        // SAFETY: the caller supplies the GlobalAlloc layout contract.
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: this allocator obtains all pointers from System.
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        count();
        // SAFETY: preserve the caller's valid allocation and requested size.
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}
#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;
static CALLS: AtomicUsize = AtomicUsize::new(0);

fn measured<T>(f: impl FnOnce() -> T) -> (T, usize) {
    struct Stop;
    impl Drop for Stop {
        fn drop(&mut self) {
            COUNTING.set(false);
        }
    }
    ALLOCATIONS.set(0);
    COUNTING.set(true);
    let guard = Stop;
    let output = f();
    drop(guard);
    (output, ALLOCATIONS.get())
}

#[test]
fn warmed_scalar_and_unit_caller_buffers_allocate_nothing_and_invoke_once() {
    let package = Package::builder("test.functionAllocations")
        .function("add", |a: i32, b: i32| {
            CALLS.fetch_add(1, Ordering::Relaxed);
            a + b
        })
        .function("reset", || {
            CALLS.fetch_add(1, Ordering::Relaxed);
        })
        .build();
    let mut target = [0u8; 9];
    package
        .invoke_frame_into(&[1, 0, 40, 44], &mut target)
        .unwrap();
    package.invoke_frame_into(&[2, 0], &mut target).unwrap();
    for (request, capacity, length) in [(&[1, 0, 40, 44][..], 9, 9), (&[2, 0][..], 8, 8)] {
        let before = CALLS.load(Ordering::Relaxed);
        let (response, allocations) =
            measured(|| package.invoke_frame_into(request, &mut target[..capacity]));
        assert!(matches!(response.unwrap(), DirectResponse::Written(n) if n == length));
        assert_eq!(allocations, 0, "warmed caller-buffer path allocated");
        assert_eq!(CALLS.load(Ordering::Relaxed) - before, 1);
    }
    // Validate the counter against the allocating frame path.
    let before = CALLS.load(Ordering::Relaxed);
    let (response, allocations) = measured(|| package.invoke_frame(&[1, 0, 40, 44]));
    assert_eq!(response.unwrap()[8], 84);
    assert_eq!(allocations, 1);
    assert_eq!(CALLS.load(Ordering::Relaxed) - before, 1);
    let before = CALLS.load(Ordering::Relaxed);
    let (response, allocations) = measured(|| package.invoke_frame_into(&[1, 0, 40, 44], &mut []));
    assert!(matches!(response.unwrap(), DirectResponse::Buffered(bytes) if bytes[8] == 84));
    assert_eq!(allocations, 1);
    assert_eq!(
        CALLS.load(Ordering::Relaxed) - before,
        1,
        "small buffer must not rerun the function"
    );
}
