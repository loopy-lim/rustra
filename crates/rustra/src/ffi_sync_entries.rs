/// `rustra_ffi_invoke` 의 디폴트 포맷 디스패치를 그대로 따르는 직렬화기 —
/// [`run_worker`] 의 cancelled 프레임이 실제 dispatch 경로와 동일한
/// 포맷(JSON/postcard)으로 인코딩되도록 한다. `None => Json` 기본값은
/// `rustra_ffi_invoke` 의 디스패치와 정확히 미러링되어야 한다 (디폴트
/// 미설정 시 두 경로가 같은 포맷을 산출).
fn sync_serialize(resp: &FfiResponse) -> Vec<u8> {
    match FFI_CONTEXT.get().map(|context| context.default_format) {
        Some(FfiFormat::Postcard) => postcard_serialize_response(resp),
        Some(FfiFormat::Json) | None => json_serialize(resp),
    }
}

// -- FFI entry points ----------------------------------------------------

/// Default path — dispatches to the configured default format.
///
/// # Safety
///
/// `payload` must point to at least `payload_len` readable bytes.
/// `out_len` must be a valid write pointer.
/// Caller must free the returned buffer with `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    match FFI_CONTEXT.get().map(|context| context.default_format) {
        Some(FfiFormat::Postcard) => unsafe {
            rustra_ffi_invoke_postcard(payload, payload_len, out_len)
        },
        Some(FfiFormat::Json) | None => unsafe {
            rustra_ffi_invoke_json(payload, payload_len, out_len)
        },
    }
}

/// JSON-over-bytes path.
///
/// Request:  JSON `{"command":"...","args":{...}}` as raw bytes.
/// Response: JSON `{"ok":bool,"result":...,"error":"..."}` as raw bytes.
///
/// # Safety
///
/// Same as [`rustra_ffi_invoke`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_json(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    if payload_len > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        return err_response(&e.to_string(), out_len, json_serialize);
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let envelope = match json_deserialize_envelope(bytes) {
        Ok(env) => env,
        Err(e) => return err_response(&e, out_len, json_serialize),
    };

    let command = envelope.command;
    let args = envelope.args;
    with_panic_guard(out_len, json_serialize, || dispatch_json(&command, args))
}

/// (성능 후속) caller-buffer JSON 변형 — 응답의 3중 복사 제거.
///
/// `buf` 가 null 이면 필요한 응답 크기를 `out_len` 에 쓰고 0 을 반환한다
/// (size-probe). `buf` 가 non-null 이면 응답을 `buf` 에 직접 기록하고 기록한
/// 바이트 수를 `out_len` 에 쓴다 — Rust 는 응답을 할당하지 않고 caller 가
/// 소유한 버퍼에 한 번만 쓴다 (malloc→복사→caller memcpy 사이클 제거).
///
/// 버퍼가 부족하면(`capacity` < 필요 크기) `out_len` 에 필요 크기를 쓰고
/// -1(`usize::MAX`)을 반환한다 — caller 가 다시 size-probe 하도록.
///
/// # Safety
///
/// `payload` must point to at least `payload_len` readable bytes.
/// `buf`, when non-null, must point to at least `capacity` writable bytes.
/// `out_len` must be a valid write pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_json_into(
    payload: *const u8,
    payload_len: usize,
    buf: *mut u8,
    capacity: usize,
    out_len: *mut usize,
) -> usize {
    if out_len.is_null() {
        return usize::MAX;
    }
    if payload.is_null() {
        unsafe { *out_len = 0 };
        return usize::MAX;
    }
    // size-probe: 임시 할당을 피하기 위해 실제 직렬화 결과 크기가 필요하다.
    // dispatch 를 한 번 실행하고 결과를 직접 caller 버퍼(또는 임시 Vec)에 쓴다.
    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    if buf.is_null() {
        // probe 단계 — 결과를 키와 함께 캐시해 이어지는 write 단계가 dispatch 를
        // 재실행하지 않게 한다(비멱등 핸들러의 사이드 이펙트 2회 방지).
        let resp = dispatch_into_bytes(bytes);
        unsafe { *out_len = resp.len() };
        json_probe_cache_store(bytes, resp);
        return 0;
    }

    // write 단계 — 같은 payload 의 probe 결과가 있으면 재사용(핸들러 1회
    // 실행 보장), 없으면(호출자가 probe 없이 바로 write) dispatch 를 실행한다.
    let response = match json_probe_cache_take(bytes) {
        Some(cached) => cached,
        None => dispatch_into_bytes(bytes),
    };

    let needed = response.len();
    unsafe { *out_len = needed };
    if capacity < needed {
        // 호출자가 작은 버퍼로 재시도해도 probe 결과를 잃지 않는다. 다음 write가
        // 같은 응답을 소비하므로 비멱등 핸들러는 여전히 정확히 1회만 실행된다.
        json_probe_cache_store(bytes, response);
        return usize::MAX; // 버퍼 부족 — 다시 probe 하라
    }
    unsafe { std::ptr::copy_nonoverlapping(response.as_ptr(), buf, needed) };
    needed
}
