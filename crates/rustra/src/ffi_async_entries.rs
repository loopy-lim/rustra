/// Async FFI invoke entry point (P0-3 worker thread offload).
///
/// Runs the command dispatch on a background worker thread, then calls `on_complete`
/// with `(user_data, response_ptr, response_len)`. The calling thread returns immediately.
///
/// 호출마다 취소 레지스트리([`crate::cancel`])에 invocation_id 를 발급한다 —
/// `invocation_id` 가 non-null 이면 그 버퍼로 복사되고, 이 ID 로
/// [`rustra_ffi_invoke_cancel`] / [`rustra_ffi_cancellation_status`] 를 호출할 수
/// 있다. null 포인터를 넘기면 ID 발급은 일어나지만 호출자에게 노출되지 않는다.
///
/// **dispatch 취소 체크포인트**: 워커가 핸들러를 실행하기 직전에 레지스트리를
/// 조회한다. cancel 이 체크포인트보다 먼저 도달했으면 핸들러는 시작하지 않고
/// `cancelled: ...` 에러 프레임이 `on_complete` 로 전달된다 (디폴트 포맷으로
/// 인코딩 — postcard 등록 시 `FfiPostcardResponse` 프레임). 체크포인트 통과
/// 후의 cancel 은 결과에 반영되지 않는다 — 핸들러는 끝까지 실행되고 정상
/// 결과가 전달된다.
///
/// # Safety
///
/// - `payload` must point to `payload_len` valid bytes (or null if len 0).
/// - `on_complete` must be a thread-safe C callback function pointer.
/// - `invocation_id` must be null or a valid u64 write pointer (out-param).
/// - The caller must free `response_ptr` using `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_async(
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
    // 크기 게이트를 복사 전에 검사한다 — 초과 페이로드를 일단 복사해 메모리가
    // 일시적으로 2배가 되던 동작(주석이 스스로 인정하던 문제)을 제거한다.
    if payload_len > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            sync_serialize,
            &e.to_string(),
        );
        return;
    }
    let bytes = if payload.is_null() || payload_len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len).to_vec() }
    };

    // 고정 워커 풀로 제출(백프레셔 포함) — 호출당 thread::spawn 의 스레드 폭증을
    // 방지한다. 큐가 가득 차면 즉시 backpressure 프레임으로 거부한다(hang 없음).
    if async_pool_submit(AsyncTask::Alloc((
        id,
        bytes,
        user_data_raw,
        on_complete,
        rustra_ffi_invoke,
        sync_serialize,
    )))
    .is_err()
    {
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            sync_serialize,
            "invoke.backpressure: async worker queue is full — retry after drain",
        );
    }
}

/// Async JSON FFI invoke entry point.
///
/// [`rustra_ffi_invoke_async`] 와 동일한 계약 — invocation_id 발급/노출, 취소
/// 심볼 연동, **dispatch 취소 체크포인트**(cancel 먼저 → 핸들러 미실행,
/// JSON `cancelled: ...` 에러 프레임이 `on_complete` 로 전달)를 포함한다.
/// 디폴트 포맷 디스패치 대신 항상 JSON 경로로 invoke 한다.
///
/// # Safety
///
/// - `payload` must point to `payload_len` valid bytes (or null if len 0).
/// - `on_complete` must be a thread-safe C callback function pointer.
/// - `invocation_id` must be null or a valid u64 write pointer (out-param).
/// - The caller must free the response pointer in the callback using `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_json_async(
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
    // 크기 게이트를 복사 전에 검사한다(위 async 엔트리와 동일).
    if payload_len > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            json_serialize,
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
        rustra_ffi_invoke_json,
        json_serialize,
    )))
    .is_err()
    {
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            json_serialize,
            "invoke.backpressure: async worker queue is full — retry after drain",
        );
    }
}
