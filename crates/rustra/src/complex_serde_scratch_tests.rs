use super::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

thread_local! {
    static ALLOCATIONS: Cell<Option<usize>> = const { Cell::new(None) };
}

struct CountingAllocator;
fn record_allocation() {
    let _ = ALLOCATIONS.try_with(|count| {
        if let Some(value) = count.get() {
            count.set(Some(value + 1));
        }
    });
}

// SAFETY: all pointers and layouts are forwarded unchanged to System. The
// thread-local counter uses a const Cell and does not allocate or synchronize.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record_allocation();
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record_allocation();
        unsafe { System.realloc(ptr, layout, size) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

fn allocations<T>(action: impl FnOnce() -> T) -> (T, usize) {
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            ALLOCATIONS.with(|count| count.set(None));
        }
    }
    ALLOCATIONS.with(|count| {
        assert!(count.get().is_none(), "allocation scopes cannot overlap");
        count.set(Some(0));
    });
    let reset = Reset;
    let result = action();
    let count = ALLOCATIONS.with(|count| count.get().unwrap());
    drop(reset);
    (result, count)
}

struct Entries(Vec<(String, Vec<i64>)>);
impl ser::Serialize for Entries {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        // Deliberately unsorted and with unknown length: no BTreeMap shortcut.
        let mut map = serializer.serialize_map(None)?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

fn map_ir() -> std::sync::Arc<IrNode> {
    crate::complex_codec::complex_schema_ir::compile(
        &serde_json::json!({"type":"object", "additionalProperties":{"type":"array", "items":{"type":"integer"}}}),
        &serde_json::json!({}),
    ).unwrap()
}

#[test]
fn small_map_into_caller_buffer_has_no_temporary_heap_allocations() {
    let ir = map_ir();
    let value = Entries(vec![("z".into(), vec![3]), ("a".into(), vec![1, 2])]);
    let targets = RecursiveTargets::new(&ir);
    let limits = ComplexCodecLimits::DEFAULT;
    let mut output = [0u8; 64];
    let mut writer = Writer::into_slice(&mut output, limits);
    let (result, count) =
        allocations(|| to_writer_direct(&value, &mut writer, &ir, &targets, limits, 0));
    result.unwrap();
    let written = writer.written;
    assert_eq!(&output[..written], &[2, 1, b'a', 2, 2, 4, 1, b'z', 1, 6]);
    assert_eq!(
        count, 0,
        "small-map sorting must not allocate temporary buffers"
    );
}

#[test]
fn map_scratch_spills_preserve_sorted_bytes_at_key_value_and_entry_boundaries() {
    let ir = map_ir();
    let limits = ComplexCodecLimits::DEFAULT;
    for entries in [0, 1, 2, 3, 64] {
        for length in [0, 23, 24, 25, 47, 48, 49, 256] {
            let value = Entries(
                (0..entries)
                    .rev()
                    .map(|i| {
                        (
                            format!("{i:03}-{}", "한".repeat(length)),
                            vec![i as i64; length],
                        )
                    })
                    .collect(),
            );
            let expected = crate::CompiledComplex::new(
                &serde_json::json!({"type":"object", "additionalProperties":{"type":"array", "items":{"type":"integer"}}}),
                &serde_json::json!({}),
            ).encode(&serde_json::to_value(&value).unwrap(), limits).unwrap();
            assert_eq!(to_bytes(&value, &ir, limits).unwrap(), expected);
        }
    }
}

#[test]
fn spilling_a_value_serializes_it_only_once() {
    struct Once<'a>(&'a Cell<usize>, String);
    impl ser::Serialize for Once<'_> {
        fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
            self.0.set(self.0.get() + 1);
            serializer.serialize_str(&self.1)
        }
    }
    let calls = Cell::new(0);
    let value = std::collections::BTreeMap::from([("large", Once(&calls, "x".repeat(512)))]);
    let schema = serde_json::json!({"type":"object", "additionalProperties":{"type":"string"}});
    let ir =
        crate::complex_codec::complex_schema_ir::compile(&schema, &serde_json::json!({})).unwrap();
    let bytes = to_bytes(&value, &ir, ComplexCodecLimits::DEFAULT).unwrap();
    assert!(bytes.ends_with(&[b'x'; 512]));
    assert_eq!(
        calls.get(),
        1,
        "spilling must move prior bytes, not replay Serialize"
    );
}

#[test]
fn scratch_exact_capacity_and_spill_keep_bytes_and_limits() {
    for key_len in [23, 24, 25] {
        for value_len in [46, 47, 48] {
            let schema =
                serde_json::json!({"type":"object", "additionalProperties":{"type":"string"}});
            let ir =
                crate::complex_codec::complex_schema_ir::compile(&schema, &serde_json::json!({}))
                    .unwrap();
            let value =
                std::collections::BTreeMap::from([("k".repeat(key_len), "v".repeat(value_len))]);
            let limits = ComplexCodecLimits::DEFAULT;
            let expected = crate::CompiledComplex::new(&schema, &serde_json::json!({}))
                .encode(&serde_json::to_value(&value).unwrap(), limits)
                .unwrap();
            assert_eq!(to_bytes(&value, &ir, limits).unwrap(), expected);
        }
    }
    let limits = ComplexCodecLimits {
        max_payload_bytes: 5,
        ..ComplexCodecLimits::DEFAULT
    };
    let mut scratch = [0; 2];
    let mut writer = Writer::with_scratch(&mut scratch, limits);
    writer.push(b"ab").unwrap();
    writer.push(b"cde").unwrap();
    assert!(writer.byte(b'f').is_err());
    assert_eq!(writer.finish_scratch().unwrap(), b"abcde");
    let mut target = [0; 2];
    let mut fixed = Writer::into_slice(&mut target, limits);
    fixed.push(b"ab").unwrap();
    assert!(fixed.byte(b'c').is_err(), "caller slices must never spill");
    assert_eq!(fixed.written, 2);
    assert_eq!(target, *b"ab");
}

#[test]
fn small_complex_response_allocates_once_and_keeps_fresh_owned_results() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    #[derive(serde::Deserialize, serde::Serialize, schemars::JsonSchema)]
    enum Status {
        Active { level: i64 },
        Idle,
    }
    #[derive(schemars::JsonSchema)]
    struct Output {
        status: Status,
        #[schemars(skip)]
        calls: Arc<AtomicUsize>,
    }
    impl ser::Serialize for Output {
        fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut output = serializer.serialize_struct("Output", 1)?;
            output.serialize_field("status", &self.status)?;
            output.end()
        }
    }
    let serializations = Arc::new(AtomicUsize::new(0));
    let handler_calls = Arc::new(AtomicUsize::new(0));
    let counted = serializations.clone();
    let handled = handler_calls.clone();
    let package = crate::Package::builder("test.response-allocation")
        .command("status", move |status: Status| {
            handled.fetch_add(1, Ordering::SeqCst);
            Ok(Output {
                status,
                calls: counted.clone(),
            })
        })
        .build();
    let request = [1, 0, 0, 14];
    package.invoke_frame(&request).unwrap();
    serializations.store(0, Ordering::SeqCst);
    handler_calls.store(0, Ordering::SeqCst);
    let (first, count) = allocations(|| package.invoke_frame(&request).unwrap());
    assert_eq!(first, [1, 0, 0, 0, 0, 0, 0, 0, 0, 14]);
    assert_eq!(serializations.load(Ordering::SeqCst), 1);
    assert_eq!(handler_calls.load(Ordering::SeqCst), 1);
    let mut second = package.invoke_frame(&[1, 0, 0, 16]).unwrap();
    second[9] = 99;
    assert_eq!(first[9], 14, "later calls must not reuse an owned result");
    assert_eq!(count, 1, "body and frame must share one allocation");
}
