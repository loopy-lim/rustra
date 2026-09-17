//! Isolated FFI context and thread-local allocation receipt; no latency measurement.
use rustra::{
    Package, RustraError,
    ffi::{rustra_ffi_has_raw, rustra_ffi_invoke_raw},
};
use serde::{Deserialize, Serialize};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    cell::Cell,
    hint::black_box,
    sync::atomic::{AtomicUsize, Ordering::Relaxed},
};

struct CountingAllocator;
thread_local! {
    static COUNTS: Cell<Option<(usize, usize)>> = const { Cell::new(None) };
}
fn record(size: usize) {
    let _ = COUNTS.try_with(|cell| {
        if let Some((calls, bytes)) = cell.get() {
            cell.set(Some((calls + 1, bytes + size)));
        }
    });
}
// SAFETY: forward each original allocation operation to System; the const TLS
// Cell records only this calling thread, without allocating or borrowing a RefCell.
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
fn measured<T>(f: impl FnOnce() -> T) -> (T, (usize, usize)) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            COUNTS.with(|c| c.set(None));
        }
    }
    COUNTS.with(|c| {
        assert!(c.get().is_none());
        c.set(Some((0, 0)));
    });
    let guard = Reset;
    let result = black_box(f());
    let count = COUNTS.with(|c| c.get().unwrap());
    drop(guard);
    (result, count)
}

#[derive(Deserialize, schemars::JsonSchema)]
struct Input {
    a: i64,
    b: i64,
}
#[derive(Serialize, schemars::JsonSchema)]
struct Output {
    value: i64,
}
static HITS: AtomicUsize = AtomicUsize::new(0);
fn add(input: Input) -> rustra::Result<Output> {
    HITS.fetch_add(1, Relaxed);
    Ok(Output {
        value: input.a + input.b,
    })
}
fn fail(_: Input) -> rustra::Result<Output> {
    HITS.fetch_add(1, Relaxed);
    Err(RustraError::invalid_args("executed raw failure"))
}
fn panics(_: Input) -> rustra::Result<Output> {
    HITS.fetch_add(1, Relaxed);
    panic!("raw handler panic")
}
struct Call {
    status: u32,
    value: u64,
    error: [u8; 512],
    len: usize,
}
fn call(id: u16, slots: &[u64], capacity: usize) -> Call {
    assert!(capacity <= 512);
    let mut result = Call {
        status: 0,
        value: 0xfeed,
        error: [0xa5; 512],
        len: 999,
    };
    // SAFETY: all pointers refer to live slices or output fields of sufficient size.
    result.status = unsafe {
        rustra_ffi_invoke_raw(
            id,
            slots.as_ptr(),
            slots.len(),
            &mut result.value,
            result.error.as_mut_ptr(),
            capacity,
            &mut result.len,
        )
    };
    result
}
fn assert_error(result: &Call, code: &str) {
    assert_eq!(result.status, 1);
    assert_eq!(result.value, 0xfeed);
    let (actual, _) = rustra::decode_frame_error_parts(&result.error[..result.len]).unwrap();
    assert_eq!(actual, code);
}

// Catches copied shapes in the success-path FFI precheck, and execution errors
// accidentally becoming fallback (which could cause a native caller to retry).
#[test]
fn raw_ffi_preserves_status_and_executes_without_shape_allocation() {
    let missing = call(1, &[4, 5], 512);
    assert_eq!(
        (missing.status, missing.value, missing.len),
        (u32::MAX, 0xfeed, 0)
    );
    let pkg = Package::builder("test.raw-allocation")
        .command("add", add)
        .command("fail", fail)
        .command("panics", panics)
        .command("locked", add)
        .require_capability("locked", "raw:run")
        .command("text", |_: String| Ok(Output { value: 0 }))
        .build();
    pkg.register_ffi();
    for id in [0, 5, u16::MAX] {
        assert_eq!(rustra_ffi_has_raw(id), 0);
        let unavailable = call(id, &[4, 5], 512);
        assert_eq!(
            (unavailable.status, unavailable.value, unavailable.len),
            (u32::MAX, 0xfeed, 0)
        );
    }
    let before = HITS.load(Relaxed);
    assert_eq!(
        rustra_ffi_has_raw(4),
        1,
        "permission is separate from raw presence"
    );
    assert_error(&call(4, &[4, 5], 512), "capability.denied");
    assert_error(&call(1, &[4], 512), "command.invalid_args");
    assert_eq!(HITS.load(Relaxed), before);
    let failure = call(2, &[4, 5], 512);
    assert_error(&failure, "command.invalid_args");
    assert_eq!(HITS.load(Relaxed), before + 1);
    for capacity in [failure.len, 8, 0] {
        let truncated = call(2, &[4, 5], capacity);
        assert_eq!(
            (truncated.status, truncated.value, truncated.len),
            (1, 0xfeed, failure.len)
        );
        assert_eq!(&truncated.error[..capacity], &failure.error[..capacity]);
        assert!(truncated.error[capacity..].iter().all(|b| *b == 0xa5));
    }
    assert_eq!(HITS.load(Relaxed), before + 4);
    assert_error(&call(3, &[4, 5], 512), "internal");
    assert_eq!(HITS.load(Relaxed), before + 5);
    let mut value = 0xfeed;
    let mut len = 999;
    // SAFETY: valid slots/outputs; null pointers exercise documented guard branches.
    unsafe {
        assert_eq!(
            rustra_ffi_invoke_raw(
                1,
                [4, 5].as_ptr(),
                2,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                &mut len
            ),
            u32::MAX
        );
        assert_eq!(len, 999);
        assert_eq!(
            rustra_ffi_invoke_raw(
                1,
                [4, 5].as_ptr(),
                2,
                &mut value,
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut()
            ),
            u32::MAX
        );
        assert_eq!(
            rustra_ffi_invoke_raw(
                2,
                [4, 5].as_ptr(),
                2,
                &mut value,
                std::ptr::null_mut(),
                512,
                &mut len
            ),
            1
        );
    }
    assert_eq!((value, len), (0xfeed, failure.len));
    assert_eq!(HITS.load(Relaxed), before + 6);

    let mut receipts = Vec::new();
    for frozen in [false, true] {
        if !frozen && pkg.is_frozen() {
            continue;
        } // Release builders start frozen.
        if frozen {
            pkg.freeze();
        }
        for id in [0, 5, u16::MAX] {
            assert_eq!(rustra_ffi_has_raw(id), 0);
            let unavailable = call(id, &[4, 5], 512);
            assert_eq!(
                (unavailable.status, unavailable.value, unavailable.len),
                (u32::MAX, 0xfeed, 0)
            );
        }
        // Construction, FFI registration, freeze and warmup are outside counting.
        assert_eq!(call(1, &[4, 5], 512).value, 9);
        let before = HITS.load(Relaxed);
        let (shape, shape_count) = measured(|| pkg.raw_invoke_shape(black_box(1)));
        assert_eq!(shape.unwrap().len(), 2);
        let (available, presence_count) = measured(|| rustra_ffi_has_raw(black_box(1)));
        assert_eq!(available, 1);
        let (direct, direct_count) = measured(|| pkg.invoke_raw(black_box(1), black_box(&[4, 5])));
        assert_eq!(direct.unwrap(), 9);
        let (result, ffi_count) = measured(|| call(black_box(1), black_box(&[4, 5]), 512));
        assert_eq!((result.status, result.value, result.len), (0, 9, 0));
        assert_eq!(HITS.load(Relaxed), before + 2);
        let actual_frozen = pkg.is_frozen();
        println!(
            "raw allocation receipt frozen={actual_frozen} shape={shape_count:?} presence={presence_count:?} direct={direct_count:?} ffi={ffi_count:?} handlerCalls=2"
        );
        receipts.push((presence_count, direct_count, ffi_count));
    }
    // Grant after freeze must affect subsequent raw dispatch without changing presence.
    assert_error(&call(4, &[4, 5], 512), "capability.denied");
    pkg.grant_capability("raw:run").unwrap();
    let before = HITS.load(Relaxed);
    let allowed = call(4, &[4, 5], 512);
    assert_eq!((allowed.status, allowed.value, allowed.len), (0, 9, 0));
    assert_eq!(HITS.load(Relaxed), before + 1);
    for (presence, direct, ffi) in receipts {
        assert_eq!(
            ffi,
            (0, 0),
            "scalar raw FFI must not allocate an unused shape"
        );
        assert_eq!(presence, (0, 0), "presence needs no owned shape");
        assert_eq!(direct, (0, 0));
    }
}
