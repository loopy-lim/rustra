//! Focused raw-dispatch lifetime and state invariants, independent of global FFI.
use rustra::{Package, get_state};
use serde::{Deserialize, Serialize};

#[derive(Deserialize, schemars::JsonSchema)]
struct Input {
    a: i64,
    b: i64,
}
#[derive(Serialize, schemars::JsonSchema)]
struct Output {
    value: i64,
}

// A read guard retained through a raw handler deadlocks its replacement; an
// uncaptured mutable command cannot safely finish after its registration changes.
#[test]
#[cfg(debug_assertions)]
fn mutable_raw_handler_can_replace_itself_and_reenter() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering::Relaxed},
        mpsc,
    };
    let (done, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let pkg = Package::builder("test.raw-reentry").build();
        let nested = pkg.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let old_calls = calls.clone();
        pkg.register("self", move |input: Input| {
            old_calls.fetch_add(1, Relaxed);
            let new_calls = old_calls.clone();
            nested.replace("self", move |input: Input| {
                new_calls.fetch_add(1, Relaxed);
                Ok(Output {
                    value: input.a * input.b,
                })
            })?;
            let result = nested.invoke_raw(1, &[3, 4])?;
            Ok(Output {
                value: input.a + result as i64,
            })
        })
        .unwrap();
        let retained_shape = pkg.raw_invoke_shape(1).unwrap();
        assert_eq!(pkg.invoke_raw(1, &[5, 6]).unwrap(), 17);
        assert_eq!(
            calls.load(Relaxed),
            2,
            "outer old and nested new each run once"
        );
        assert_eq!(pkg.invoke_raw(1, &[2, 4]).unwrap(), 8);
        assert_eq!(calls.load(Relaxed), 3);
        pkg.unregister("self").unwrap();
        assert!(pkg.raw_invoke_shape(1).is_none());
        assert_eq!(
            pkg.invoke_raw(1, &[1, 2]).unwrap_err().code(),
            "command.not_found"
        );
        assert_eq!(
            retained_shape.len(),
            2,
            "owned handshake snapshot survives mutation"
        );
        done.send(()).unwrap();
    });
    receive
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("raw handler replacement/reentry must not retain the registry lock");
    worker.join().unwrap();
}

// Removing/reordering the shared state/panic guard would leak the outer state's
// value into an empty inner package or fail to restore it after a nested panic.
#[test]
fn raw_nested_state_is_masked_and_restored_after_panic() {
    for frozen in [false, true] {
        let empty = Package::builder("test.raw-empty")
            .command("check", |_: Input| {
                assert!(get_state::<u32>().is_none());
                Ok(Output { value: 7 })
            })
            .build();
        let seen_inner = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let seen_from_handler = seen_inner.clone();
        let inner = Package::builder("test.raw-inner")
            .manage(9u32)
            .command("panic", move |_: Input| -> rustra::Result<Output> {
                seen_from_handler.store(
                    get_state::<u32>().map(|value| *value).unwrap_or(0),
                    std::sync::atomic::Ordering::Relaxed,
                );
                panic!("nested raw panic");
            })
            .build();
        if frozen {
            empty.freeze();
            inner.freeze();
        }
        let outer = Package::builder("test.raw-outer")
            .manage(42u32)
            .command("outer", move |input: Input| {
                assert_eq!(**get_state::<u32>().as_ref().unwrap(), 42);
                assert_eq!(empty.invoke_raw(1, &[1, 2])?, 7);
                assert_eq!(**get_state::<u32>().as_ref().unwrap(), 42);
                let error = inner.invoke_raw(1, &[1, 2]).unwrap_err();
                assert_eq!(seen_inner.load(std::sync::atomic::Ordering::Relaxed), 9);
                assert_eq!(error.code(), "internal");
                assert!(error.to_string().contains("panic in handler:"));
                assert_eq!(**get_state::<u32>().as_ref().unwrap(), 42);
                Ok(Output {
                    value: input.a + input.b,
                })
            })
            .build();
        if frozen {
            outer.freeze();
        }
        assert_eq!(outer.invoke_raw(1, &[20, 22]).unwrap(), 42);
        assert!(
            get_state::<u32>().is_none(),
            "top-level state must also be restored"
        );
    }
}
