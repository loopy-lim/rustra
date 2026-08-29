/// Returns 1 when the registered package has a raw scalar handler for the
/// numeric command id, otherwise 0. Hosts combine this runtime fact with their
/// generated codec metadata before advertising Tier 0 to JavaScript.
#[unsafe(no_mangle)]
pub extern "C" fn rustra_ffi_has_raw(command_id: u16) -> u8 {
    u8::from(
        get_package()
            .and_then(|pkg| pkg.raw_invoke_shape(command_id))
            .is_some(),
    )
}

/// rkyv V2 caller-buffer 변형 — JSI typed fast path 의 malloc→memcpy→free
/// 사이클 제거 경로.
///
/// `buf` 가 null 이면 필요한 응답 크기를 `out_len` 에 쓰고 0을 반환한다
/// (size-probe). `buf` 가 non-null 이면 응답을 `buf` 에 직접 기록하고 기록한
/// 바이트 수를 반환한다 — Rust 는 코어 FFI 레이아웃 버퍼를 할당하지 않는다.
/// 버퍼가 부족하면 `usize::MAX` 를 반환한다(재probe 신호).
///
/// probe → write 사이의 핸들러 1회 실행 보장은 JSON caller-buffer
/// ([`rustra_ffi_invoke_json_into`]) 와 동일한 probe 캐시를 공유하지 않는다 —
/// rkyv V2 와이어는 payload 가 바이너리 프레임이라 JSON 캐시 키와 다르다.
/// 대신 동일한 thread-local 슬롯(rkyv V2 전용)로 probe 결과를 재사용한다.
///
/// # Safety
///
/// `payload` must point to at least `payload_len` readable bytes.
/// `buf`, when non-null, must point to at least `capacity` writable bytes.
/// `out_len` must be a valid write pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_rkyv_v2_into(
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
    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    if buf.is_null() {
        let resp = rkyv_v2_dispatch_bytes(bytes);
        unsafe { *out_len = resp.len() };
        rkyv_probe_cache_store(bytes, resp);
        return 0;
    }

    if let Some(response) = rkyv_probe_cache_take(bytes) {
        let needed = response.len();
        unsafe { *out_len = needed };
        if capacity < needed {
            rkyv_probe_cache_store(bytes, response);
            return usize::MAX;
        }
        unsafe { std::ptr::copy_nonoverlapping(response.as_ptr(), buf, needed) };
        return needed;
    }

    let target = unsafe { std::slice::from_raw_parts_mut(buf, capacity) };
    let direct = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        get_package()
            .ok_or_else(|| {
                crate::RustraError::custom("ffi.not_registered", "package not registered")
            })
            .and_then(|pkg| pkg.invoke_rkyv_v2_into(bytes, target))
    })) {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            crate::rkyv_codec::DirectResponse::Buffered(crate::encode_rkyv_v2_error(&error))
        }
        Err(panic) => crate::rkyv_codec::DirectResponse::Buffered(crate::encode_rkyv_v2_error(
            &crate::RustraError::internal(panic_frame_message(&*panic)),
        )),
    };

    match direct {
        crate::rkyv_codec::DirectResponse::Written(written) => {
            unsafe { *out_len = written };
            written
        }
        crate::rkyv_codec::DirectResponse::Buffered(response) => {
            let needed = response.len();
            unsafe { *out_len = needed };
            if capacity < needed {
                rkyv_probe_cache_store(bytes, response);
                return usize::MAX;
            }
            unsafe { std::ptr::copy_nonoverlapping(response.as_ptr(), buf, needed) };
            needed
        }
    }
}

/// rkyv V2 caller-buffer 경로의 dispatch — 패닉 가드 포함, 응답 바이트 반환.
fn rkyv_v2_dispatch_bytes(bytes: &[u8]) -> Vec<u8> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        get_package()
            .ok_or_else(|| {
                crate::RustraError::custom("ffi.not_registered", "package not registered")
            })
            .and_then(|pkg| pkg.invoke_rkyv_v2(bytes))
    })) {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => crate::encode_rkyv_v2_error(&error),
        Err(panic) => {
            crate::encode_rkyv_v2_error(&crate::RustraError::internal(panic_frame_message(&*panic)))
        }
    }
}
