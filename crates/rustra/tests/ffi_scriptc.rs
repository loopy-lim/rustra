//! Retained foreign callbacks use borrowed payloads and identity-paired release.
use rustra::ffi::*;
use std::ffi::{CStr, c_char, c_void};
use std::sync::{Arc, Barrier, mpsc};
use std::time::Duration;

unsafe extern "C" fn bytes_callback(context: *mut c_void, handle: u32, ptr: *const u8, len: usize) {
    let sender = unsafe { &*context.cast::<mpsc::Sender<(u32, Vec<u8>)>>() };
    let bytes = if len == 0 {
        vec![]
    } else {
        unsafe { std::slice::from_raw_parts(ptr, len).to_vec() }
    };
    let _ = sender.send((handle, bytes));
}

unsafe extern "C" fn event_callback(
    context: *mut c_void,
    name: *const c_char,
    payload: *const c_char,
) {
    let sender = unsafe { &*context.cast::<mpsc::Sender<(String, String)>>() };
    let _ = sender.send((
        unsafe { CStr::from_ptr(name) }
            .to_string_lossy()
            .into_owned(),
        unsafe { CStr::from_ptr(payload) }
            .to_string_lossy()
            .into_owned(),
    ));
}

#[test]
fn retained_callbacks_deliver_release_and_reject_stale_owners() {
    let (started_tx, started_rx) = mpsc::channel();
    let barrier = Arc::new(Barrier::new(2));
    let worker_barrier = barrier.clone();
    let (block_started_tx, block_started_rx) = mpsc::channel();
    let blocked_workers = Arc::new(Barrier::new(3));
    let worker_release = blocked_workers.clone();
    let cancelled_handler_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = cancelled_handler_calls.clone();
    let package = rustra::Package::builder("scriptc.test")
        .command("echo", |value: String| Ok::<_, rustra::RustraError>(value))
        .command("wait", move |value: String| {
            started_tx.send(()).unwrap();
            worker_barrier.wait();
            Ok::<_, rustra::RustraError>(value)
        })
        .command("blockBoth", move |value: String| {
            block_started_tx.send(()).unwrap();
            worker_release.wait();
            Ok::<_, rustra::RustraError>(value)
        })
        .command("cancelCount", move |value: String| {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok::<_, rustra::RustraError>(value)
        })
        .event::<String>("notice")
        .build();
    package.clone().register_ffi();
    let (tx, rx) = mpsc::channel::<(u32, Vec<u8>)>();
    let context = (&tx as *const mpsc::Sender<_>).cast_mut().cast();
    let handle = unsafe { rustra_ffi_channel_create_bytes(bytes_callback, context) };
    assert_ne!(handle, 0);
    let payload = br#"{"command":"echo","args":"hello"}"#;
    let id =
        unsafe { rustra_ffi_invoke_json_async_channel(payload.as_ptr(), payload.len(), handle) };
    assert_ne!(id, 0);
    let (received_handle, bytes) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(handle, received_handle);
    let envelope: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(envelope["result"], "hello");
    assert_eq!(unsafe { rustra_ffi_cancellation_status(id) }, 0);

    // Oversized input completes synchronously before a worker copies it; malformed
    // input completes on a worker. Both use the same borrowed channel envelope.
    for payload in [
        vec![b' '; unsafe { rustra_ffi_get_max_payload() } + 1],
        b"{".to_vec(),
    ] {
        let id = unsafe {
            rustra_ffi_invoke_json_async_channel(payload.as_ptr(), payload.len(), handle)
        };
        assert_ne!(id, 0);
        let (_, bytes) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let envelope: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(envelope["ok"], false);
        let error = envelope["error"].as_str().unwrap();
        assert!(!error.is_empty());
        if payload.len() > 1 {
            assert!(error.contains("payload.too_large"));
        }
        assert_eq!(unsafe { rustra_ffi_cancellation_status(id) }, 0);
    }
    assert!(
        rx.try_recv().is_err(),
        "error completion must happen exactly once"
    );

    // Both workers are parked before queuing the cancellable command. No timing
    // assumption decides whether the handler crossed its dispatch checkpoint.
    assert_eq!(async_pool_stats().pool_size, 2);
    let payload = br#"{"command":"blockBoth","args":"blocked"}"#;
    for _ in 0..2 {
        unsafe { rustra_ffi_invoke_json_async_channel(payload.as_ptr(), payload.len(), handle) };
    }
    for _ in 0..2 {
        block_started_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap();
    }
    let payload = br#"{"command":"cancelCount","args":"never"}"#;
    let cancelled_id =
        unsafe { rustra_ffi_invoke_json_async_channel(payload.as_ptr(), payload.len(), handle) };
    assert!(unsafe { rustra_ffi_invoke_cancel(cancelled_id) });
    blocked_workers.wait();
    let mut cancellations = 0;
    for _ in 0..3 {
        let (_, bytes) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let envelope: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        if envelope["ok"] == false {
            assert!(
                envelope["error"]
                    .as_str()
                    .unwrap()
                    .starts_with("cancelled:")
            );
            cancellations += 1;
        }
    }
    assert_eq!(cancellations, 1);
    assert_eq!(
        cancelled_handler_calls.load(std::sync::atomic::Ordering::SeqCst),
        0
    );
    assert_eq!(unsafe { rustra_ffi_cancellation_status(cancelled_id) }, 0);

    // Repeated registrations have independent handles and counted release.
    let handle2 = unsafe { rustra_ffi_channel_create_bytes(bytes_callback, context) };
    unsafe { rustra_ffi_channel_release_scriptc(bytes_callback, context) };
    assert_eq!(
        unsafe { rustra_ffi_channel_send_bytes(handle2, b"x".as_ptr(), 1) },
        0
    );
    assert_eq!(
        unsafe { rustra_ffi_channel_send_bytes(handle, b"x".as_ptr(), 1) },
        1
    );
    assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap().1, b"x");

    // Closing while a handler runs disables delivery without retaining or
    // dereferencing host userdata after release. The response still gets freed.
    let payload = br#"{"command":"wait","args":"late"}"#;
    let id =
        unsafe { rustra_ffi_invoke_json_async_channel(payload.as_ptr(), payload.len(), handle) };
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    unsafe { rustra_ffi_channel_release_scriptc(bytes_callback, context) };
    drop(tx);
    barrier.wait();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while unsafe { rustra_ffi_cancellation_status(id) } != 0 {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
    assert_eq!(
        unsafe { rustra_ffi_invoke_json_async_channel(payload.as_ptr(), payload.len(), handle) },
        0
    );

    let (old_tx, old_rx) = mpsc::channel::<(String, String)>();
    let (new_tx, new_rx) = mpsc::channel::<(String, String)>();
    let old_context = (&old_tx as *const mpsc::Sender<_>).cast_mut().cast();
    let new_context = (&new_tx as *const mpsc::Sender<_>).cast_mut().cast();
    unsafe {
        rustra_ffi_event_sink_register_scriptc(event_callback, old_context);
        rustra_ffi_event_sink_register_scriptc(event_callback, new_context);
        rustra_ffi_event_sink_release_scriptc(event_callback, old_context);
    }
    package.emit("notice", "event");
    assert_eq!(
        new_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        ("notice".to_owned(), "\"event\"".to_owned())
    );
    assert!(old_rx.try_recv().is_err());
    unsafe { rustra_ffi_event_sink_release_scriptc(event_callback, new_context) };
    package.emit("notice", "after release");
    assert!(new_rx.try_recv().is_err());
    event_release_waits_for_callback(&package);
}

struct BlockingCallback {
    entered: Barrier,
    release: Barrier,
}

unsafe extern "C" fn blocking_bytes(context: *mut c_void, _: u32, _: *const u8, _: usize) {
    let state = unsafe { &*context.cast::<BlockingCallback>() };
    state.entered.wait();
    state.release.wait();
}

unsafe extern "C" fn blocking_event(context: *mut c_void, _: *const c_char, _: *const c_char) {
    let state = unsafe { &*context.cast::<BlockingCallback>() };
    state.entered.wait();
    state.release.wait();
}

#[test]
fn channel_release_waits_for_active_callback() {
    let state = Arc::new(BlockingCallback {
        entered: Barrier::new(2),
        release: Barrier::new(2),
    });
    let handle = unsafe {
        rustra_ffi_channel_create_bytes(blocking_bytes, Arc::as_ptr(&state).cast_mut().cast())
    };
    let send = std::thread::spawn(move || unsafe {
        rustra_ffi_channel_send_bytes(handle, b"x".as_ptr(), 1)
    });
    state.entered.wait();
    let released_state = state.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let (started_tx, started_rx) = mpsc::channel();
    let release = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        unsafe {
            rustra_ffi_channel_release_scriptc(
                blocking_bytes,
                Arc::as_ptr(&released_state).cast_mut().cast(),
            )
        };
        done_tx.send(()).unwrap();
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let returned_early = done_rx.recv_timeout(Duration::from_millis(25)).is_ok();
    state.release.wait();
    send.join().unwrap();
    release.join().unwrap();
    assert!(
        !returned_early,
        "release must wait until borrowed callback data is quiescent"
    );
    done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(state);
    assert_eq!(
        unsafe { rustra_ffi_channel_send_bytes(handle, b"late".as_ptr(), 4) },
        0
    );
}

fn event_release_waits_for_callback(package: &rustra::Package) {
    let state = Arc::new(BlockingCallback {
        entered: Barrier::new(2),
        release: Barrier::new(2),
    });
    unsafe {
        rustra_ffi_event_sink_register_scriptc(
            blocking_event,
            Arc::as_ptr(&state).cast_mut().cast(),
        )
    };
    let emitter_package = package.clone();
    let emit = std::thread::spawn(move || emitter_package.emit("notice", "blocked"));
    state.entered.wait();
    let released_state = state.clone();
    let (done_tx, done_rx) = mpsc::channel();
    let (started_tx, started_rx) = mpsc::channel();
    let release = std::thread::spawn(move || {
        started_tx.send(()).unwrap();
        unsafe {
            rustra_ffi_event_sink_release_scriptc(
                blocking_event,
                Arc::as_ptr(&released_state).cast_mut().cast(),
            )
        };
        done_tx.send(()).unwrap();
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let returned_early = done_rx.recv_timeout(Duration::from_millis(25)).is_ok();
    state.release.wait();
    emit.join().unwrap();
    release.join().unwrap();
    assert!(
        !returned_early,
        "event release must wait for the active callback"
    );
    done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(state);
    package.emit("notice", "after release");
}
