/// rkyv V2 비동기 진입점 — [`rustra_ffi_invoke_async`] 와 동일한 계약
/// (invocation_id 발급, 워커 스레드 dispatch, cancel 체크포인트, complete 후
/// on_complete 1회)을 rkyv V2 와이어로 제공한다.
///
/// # Safety
///
/// - `payload` must point to `payload_len` valid bytes (or null if len 0).
/// - `on_complete` must be a thread-safe C callback function pointer.
/// - `invocation_id` must be null or a valid u64 write pointer (out-param).
/// - The caller must free `response_ptr` using `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_rkyv_v2_async(
    payload: *const u8,
    payload_len: usize,
    user_data: *mut c_void,
    on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
    invocation_id: *mut u64,
) {
    let id = crate::cancel::register_invocation();
    if !invocation_id.is_null() {
        unsafe { *invocation_id = id };
    }
    let user_data_raw = user_data as usize;
    if payload_len > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            rkyv_error_bytes,
            &e.to_string(),
        );
        return;
    }
    let bytes = if payload.is_null() || payload_len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len).to_vec() }
    };

    if async_pool_submit(AsyncTask::Alloc((
        id,
        bytes,
        user_data_raw,
        on_complete,
        rustra_ffi_invoke_rkyv_v2,
        rkyv_error_bytes,
    )))
    .is_err()
    {
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            rkyv_error_bytes,
            "invoke.backpressure: async worker queue is full — retry after drain",
        );
    }
}

/// rkyv V2 비동기 caller-buffer 변형 — [`rustra_ffi_invoke_rkyv_v2_async`] 와
/// 동일한 계약(invocation_id 발급, 워커 스레드 dispatch, cancel 체크포인트,
/// complete 후 on_complete 1회)에 호스트 제공 응답 버퍼를 더한다.
///
/// `buf`/`capacity` — 호스트가 소유한 응답 버퍼. **수명 계약**: 호스트는
/// 완료 콜백이 실행되는 동안 버퍼를 살아 있게 유지해야 하며, 콜백이 돌아온
/// 뒤에 해제한다(호출 스레드는 즉시 반환하므로 버퍼를 스택에 둘 수 없다 —
/// 힙/persistent 버퍼여야 한다). 워커가 버퍼에 응답을 쓰는 동안 호스트는
/// 그 버퍼를 읽거나 다른 용도로 쓰지 않는다(단일 소유자 — dispatch 중).
///
/// 완료 콜백 `on_complete(user_data, resp_ptr, resp_len, owned)`:
/// - `owned=0` — `resp_ptr` 은 호스트가 넘긴 `buf` 자체다. 응답은 그 안에
///   있고 별도 해제는 없다.
/// - `owned=1` — 응답이 버퍼에 안 들어갔다(overflow 또는 null buf). Rust 가
///   heap 프레임을 새로 만들었으므로 호스트는 `rustra_ffi_free` 로 정확히
///   1회 해제해야 한다.
///
/// overflow 시에도 재시도(signalling) 프로토콜을 쓰지 않는다 — sync `_into`
/// 의 probe → write 2단계는 thread-local probe 캐시에 의존하는데, 재시도
/// 호출이 2워커 풀의 다른 스레드에 배정되면 캐시가 미스나 비멱등 핸들러가
/// 재실행된다. 대신 워커가 **같은 dispatch 안에서** heap 프레임으로 폴백해
/// owned=1 로 전달한다 — 핸들러는 항상 정확히 1회 실행된다.
///
/// # Safety
///
/// - `payload` must point to `payload_len` valid bytes (or null if len 0).
/// - `buf`, when non-null, must point to at least `capacity` writable bytes
///   and must outlive the completion callback (heap or persistent storage).
/// - `on_complete` must be a thread-safe C callback function pointer.
/// - `invocation_id` must be null or a valid u64 write pointer (out-param).
/// - When the callback reports `owned=1`, the caller must free `resp_ptr`
///   with `rustra_ffi_free`. With `owned=0` the pointer is the caller's own
///   buffer and must not be freed through the FFI.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_rkyv_v2_async_into(
    payload: *const u8,
    payload_len: usize,
    buf: *mut u8,
    capacity: usize,
    user_data: *mut c_void,
    on_complete: Option<UnsafeIntoComplete>,
    invocation_id: *mut u64,
) {
    let id = crate::cancel::register_invocation();
    if !invocation_id.is_null() {
        unsafe { *invocation_id = id };
    }
    let user_data_raw = user_data as usize;
    // 즉시 실패(payload-too-large / backpressure) 공용 완료 — 버퍼에 에러
    // 프레임을 복사할 수 있으면 owned=0, 아니면 owned=1. 콜백 1회 + 레지스트리
    // 정리 계약은 워커 경로(`run_worker_into`)와 동일하게 유지된다.
    let deliver_immediate = |frame: Vec<u8>| {
        let (ptr, len, owned) = deliver_into_frame(frame, buf, capacity);
        crate::cancel::complete_invocation(id);
        if let Some(cb) = on_complete {
            unsafe { cb(user_data_raw as *mut c_void, ptr, len, owned) };
        } else if owned == 1 && !ptr.is_null() {
            unsafe { rustra_ffi_free(ptr, len) };
        }
    };
    if payload_len > max_payload_bytes() {
        // 크기 게이트 실패는 호출 스레드에서 즉시 완료한다.
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        deliver_immediate(crate::encode_rkyv_v2_error(&e));
        return;
    }
    let bytes = if payload.is_null() || payload_len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len).to_vec() }
    };

    if async_pool_submit(AsyncTask::Into(AsyncIntoJob {
        id,
        bytes,
        buf_raw: buf as usize,
        capacity,
        user_data_raw,
        on_complete,
    }))
    .is_err()
    {
        // 백프레셔도 동일한 즉시 완료 규칙을 따른다.
        let e = crate::RustraError::custom(
            "invoke.backpressure",
            "async worker queue is full — retry after drain",
        )
        .retryable();
        deliver_immediate(crate::encode_rkyv_v2_error(&e));
    }
}
