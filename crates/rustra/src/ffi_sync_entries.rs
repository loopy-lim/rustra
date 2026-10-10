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

/// caller-buffer JSON 변형 — 응답의 3중 복사 제거(구현 완료: probe → write
/// 2단계 프로토콜, trust_baseline_ffi.rs 가 검증한다).
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

/// scriptc 형태 caller-buffer 변형 — 길이를 out 포인터 대신 **반환값**으로 돌려준다.
/// scriptc(0.2.x)의 직접 FFI 세계는 포인터 클래스 인자를 bigint 주소로만 공급할 수
/// 있어(caller 가 쓰기 가능한 외부 메모리 주소를 얻는 프리미티브가 없다) out_len
/// 필수 계약인 `rustra_ffi_invoke_json_into` 를 그대로 바인드할 수 없다. 이 엔트리는
/// 같은 dispatch/probe-cache 경로를 스택 로컬 out_len 으로 위임해 구현을 단일화한다.
///
/// - 성공: 기록한 바이트 수를 반환한다.
/// - `buf == null`(size-probe 모드)은 이 경로에서 관측 불가 — 0 을 반환한다
///   (필요 크기는 사라진다; scriptc caller 는 고정 버퍼를 소유하는 모델이다).
/// - 버퍼 부족·payload null 등 실패: `usize::MAX`.
///
/// # Safety
///
/// `rustra_ffi_invoke_json_into` 와 동일 — `payload` 는 `payload_len` 바이트 읽기
/// 가능, `buf` 는 non-null 이며 `capacity` 바이트 쓰기 가능이어야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_json_into_len(
    payload: *const u8,
    payload_len: usize,
    buf: *mut u8,
    capacity: usize,
) -> usize {
    let mut out_len: usize = 0;
    unsafe { rustra_ffi_invoke_json_into(payload, payload_len, buf, capacity, &mut out_len) }
}
