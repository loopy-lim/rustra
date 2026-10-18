// Retained foreign-thread callbacks for static FFI hosts. The scriptc manifest
// supplies callback identity/context on release; no owned Rust pointer crosses
// this interface. Existing Node/RN entry points and wire formats are unchanged.

/// Plain C event callback. Strings are borrowed until this callback returns.
pub type FfiScriptcEventCallback =
    unsafe extern "C" fn(user_data: *mut c_void, name: *const c_char, payload: *const c_char);

/// Release one bytes channel registered with this exact callback and context.
/// Multiple registrations of the same pair are released newest first.
///
/// # Safety
/// The callback/context must be the pair used by `rustra_ffi_channel_create_bytes`.
/// Do not call synchronously inside the native callback: release waits for all
/// active callbacks. scriptc's foreign trampoline queues script work, so a script
/// closure can release itself after the native trampoline has returned.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_channel_release_scriptc(
    callback: FfiChannelBytesCallback,
    user_data: *mut c_void,
) {
    let removed = {
        let mut sinks = FFI_CHANNEL_BYTES_SINKS
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let handle = sinks.iter().rev().find_map(|(handle, sink)| {
            (std::ptr::fn_addr_eq(sink.0.callback, callback) && sink.0.user_data == user_data)
                .then_some(*handle)
        });
        handle.and_then(|handle| sinks.remove(&handle).map(|sink| (handle, sink)))
    };
    if let Some((handle, sink)) = removed {
        crate::channels::host().drop_channel(handle);
        sink.deactivate_and_wait();
    }
}

struct ScriptcAsyncCompletion(FfiChannelBytesSink);

unsafe extern "C" fn complete_scriptc_async(
    user_data: *mut c_void,
    response: *mut u8,
    length: usize,
) {
    // The existing async entry transfers both the completion context and its
    // header allocation exactly once, including early rejection/backpressure.
    let completion = unsafe { Box::from_raw(user_data.cast::<ScriptcAsyncCompletion>()) };
    struct Response(*mut u8, usize);
    impl Drop for Response {
        fn drop(&mut self) {
            unsafe { rustra_ffi_free(self.0, self.1) };
        }
    }
    let response = Response(response, length);
    let bytes = if response.0.is_null() || response.1 == 0 {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(response.0, response.1) }
    };
    completion.0.invoke(bytes);
}

/// Submit a JSON invocation and deliver its envelope to a retained bytes channel.
/// Returns the ordinary cancellation ID, or zero without dispatch for an unknown
/// channel. Closing the channel suppresses later delivery, but does not cancel
/// an already running command; cancellation remains cooperative.
///
/// # Safety
/// `payload` must point to `payload_len` readable bytes for this call (null is
/// permitted only for zero length). The registered channel callback must obey
/// its thread-safety and lifetime contract. Rust owns/frees the response after
/// the borrowed callback returns; the host must copy any data it keeps.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_json_async_channel(
    payload: *const u8,
    payload_len: usize,
    channel: u32,
) -> u64 {
    let sink = FFI_CHANNEL_BYTES_SINKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .get(&channel)
        .cloned();
    let Some(sink) = sink else { return 0 };
    let context = Box::into_raw(Box::new(ScriptcAsyncCompletion(sink)));
    let mut id = 0;
    unsafe {
        rustra_ffi_invoke_json_async(
            payload,
            payload_len,
            context.cast(),
            Some(complete_scriptc_async),
            &mut id,
        );
    }
    id
}

/// Register a plain C event trampoline, replacing the previous global sink.
///
/// # Safety
/// The callback must not unwind, and must be thread-safe. Context and callback
/// stay valid until replacement or matching release completes. String data is
/// borrowed only for the callback. Synchronous native self-release is forbidden.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_event_sink_register_scriptc(
    callback: FfiScriptcEventCallback,
    user_data: *mut c_void,
) {
    let new_sink = FfiEventSink::with_callback(FfiEventCallbackKind::Plain(callback), user_data);
    swap_global_event_sink(Some(new_sink), None);
}

/// Release the global event sink only if it still belongs to this registration.
/// Releasing an older registration cannot unregister a newer owner's sink.
/// Ownership is callback/context identity: reusing the exact pair is the same
/// owner, not a new generation. A distinct owner must use a distinct live context.
///
/// # Safety
/// Supply the registered callback/context pair. Do not release synchronously
/// inside a native callback; the release waits for in-flight callbacks to finish.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_event_sink_release_scriptc(
    callback: FfiScriptcEventCallback,
    user_data: *mut c_void,
) {
    swap_global_event_sink(None, Some((callback, user_data)));
}
