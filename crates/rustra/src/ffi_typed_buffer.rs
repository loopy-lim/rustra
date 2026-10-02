/// Returns 1 when the registered package has a raw scalar handler for the
/// numeric command id, otherwise 0. Hosts combine this runtime fact with their
/// generated codec metadata before advertising Tier 0 to JavaScript.
#[unsafe(no_mangle)]
pub extern "C" fn rustra_ffi_has_raw(command_id: u16) -> u8 {
    u8::from(get_package().is_some_and(|pkg| pkg.has_raw_handler(command_id)))
}

/// Frame caller-buffer 변형 — JSI typed fast path 의 malloc→memcpy→free
/// 사이클 제거 경로.
///
/// `buf` 가 null 이면 필요한 응답 크기를 `out_len` 에 쓰고 0을 반환한다
/// (size-probe). `buf` 가 non-null 이면 응답을 `buf` 에 직접 기록하고 기록한
/// 바이트 수를 반환한다 — Rust 는 코어 FFI 레이아웃 버퍼를 할당하지 않는다.
/// 버퍼가 부족하면 `usize::MAX` 를 반환한다(재probe 신호).
///
/// probe → write 사이의 핸들러 1회 실행 보장은 JSON caller-buffer
/// ([`rustra_ffi_invoke_json_into`]) 와 동일한 probe 캐시를 공유하지 않는다 —
/// Frame 와이어는 payload 가 바이너리 프레임이라 JSON 캐시 키와 다르다.
/// 대신 동일한 thread-local 슬롯(Frame 전용)로 probe 결과를 재사용한다.
///
/// # Safety
///
/// `payload` must point to at least `payload_len` readable bytes.
/// `buf`, when non-null, must point to at least `capacity` writable bytes.
/// `out_len` must be a valid write pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_frame_into(
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
        let resp = frame_dispatch_bytes(bytes);
        unsafe { *out_len = resp.len() };
        frame_probe_cache_store(bytes, resp);
        return 0;
    }

    if let Some(response) = frame_probe_cache_take(bytes) {
        let needed = response.len();
        unsafe { *out_len = needed };
        if capacity < needed {
            frame_probe_cache_store(bytes, response);
            return usize::MAX;
        }
        unsafe { std::ptr::copy_nonoverlapping(response.as_ptr(), buf, needed) };
        return needed;
    }

    let target = unsafe { std::slice::from_raw_parts_mut(buf, capacity) };
    let direct = frame_into_dispatch(get_package(), bytes, target);

    match direct {
        crate::frame_codec::DirectResponse::Written(written) => {
            unsafe { *out_len = written };
            written
        }
        crate::frame_codec::DirectResponse::Buffered(response) => {
            let needed = response.len();
            unsafe { *out_len = needed };
            if capacity < needed {
                frame_probe_cache_store(bytes, response);
                return usize::MAX;
            }
            unsafe { std::ptr::copy_nonoverlapping(response.as_ptr(), buf, needed) };
            needed
        }
    }
}

/// Frame caller-buffer dispatch 공통 코어 — 패닉 가드로 `invoke_frame_into` 를
/// 실행하고 `DirectResponse` 로 정규화한다. probe 경로
/// ([`rustra_ffi_invoke_frame_into`]) 와 owned 경로
/// ([`rustra_ffi_invoke_frame_owned`]) 가 같은 와이어·핸들러 1회 계약을
/// 공유하는 단일 지점이다(테스트는 패키지를 직접 전달해 계약을 검증한다).
fn frame_into_dispatch(
    pkg: Option<&Package>,
    bytes: &[u8],
    target: &mut [u8],
) -> crate::frame_codec::DirectResponse {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        pkg.ok_or_else(|| {
            crate::RustraError::custom("ffi.not_registered", "package not registered")
        })
        .and_then(|pkg| pkg.invoke_frame_into(bytes, target))
    })) {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            crate::frame_codec::DirectResponse::Buffered(crate::encode_frame_error(&error))
        }
        Err(panic) => crate::frame_codec::DirectResponse::Buffered(crate::encode_frame_error(
            &crate::RustraError::internal(panic_frame_message(&*panic)),
        )),
    }
}

/// Frame caller-buffer 의 owned 응답 변형 — 동기 tail 의 probe-cache 2-FFI
/// 왕복 제거(E1).
///
/// [`rustra_ffi_invoke_frame_into`] 와 동일하게 핸들러를 정확히 1회 실행하지만,
/// 응답이 caller 버퍼에 들어가지 않는 순간 probe 캐시(요청 전체 복사·비교,
/// SIZE_MAX 재시도 신호) 없이 응답 Vec 의 소유권을 caller 에 넘긴다 — 비동기
/// 경로([`rustra_ffi_invoke_frame_async_into`])의 owned=1 프레임 계약을
/// 동기 호출로 옮긴 것이다.
///
/// - 반환 null — 응답이 `buf` 에 기록됐다(작은 응답, `buf` 에 들어가는 에러
///   프레임). 기록한 바이트 수가 `*out_len` 이며 caller 는 해제할 것이 없다.
/// - 반환 non-null — 응답이 overflow 라 Rust heap 프레임으로 전달됐다.
///   `*out_len` 이 응답 길이이며, caller 는 [`rustra_ffi_free_owned_bytes`] 를
///   정확히 (ptr, *out_len) 쌍으로 1회 호출해야 한다(헤더 없는 owned 할당 —
///   [`rustra_ffi_invoke_buffer`] 와 같은 free 짝).
///
/// overflow 폴백이 같은 dispatch 안에서 일어나므로 재시도 프로토콜이 없고
/// 비멱등 핸들러도 안전하다. 핫코어 호스트는 진입을 로드한 코어 테이블로
/// 호출해야 한다(생산 코어의 allocator 로 해제되게 — 테이블 옵셔널 엔트리).
///
/// # Safety
///
/// - `payload` must point to at least `payload_len` readable bytes.
/// - `buf`, when non-null, must point to at least `capacity` writable bytes.
/// - `out_len` must be a valid write pointer.
/// - When a non-null pointer is returned, it must be freed exactly once with
///   `rustra_ffi_free_owned_bytes(ptr, *out_len)`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_frame_owned(
    payload: *const u8,
    payload_len: usize,
    buf: *mut u8,
    capacity: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if out_len.is_null() {
        return std::ptr::null_mut();
    }
    if payload.is_null() {
        unsafe { *out_len = 0 };
        return std::ptr::null_mut();
    }
    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };
    let target: &mut [u8] = if buf.is_null() {
        &mut []
    } else {
        unsafe { std::slice::from_raw_parts_mut(buf, capacity) }
    };
    let direct = frame_into_dispatch(get_package(), bytes, target);
    match direct {
        crate::frame_codec::DirectResponse::Written(written) => {
            unsafe { *out_len = written };
            std::ptr::null_mut()
        }
        crate::frame_codec::DirectResponse::Buffered(response) => {
            // `buf` 에 들어가는 프레임(작은 에러 프레임)은 복사로 끝낸다 —
            // 비동기 deliver_into_frame 의 owned=0 규칙과 동일. overflow 만
            // owned 핸드오프가 된다.
            let needed = response.len();
            if !buf.is_null() && capacity >= needed {
                unsafe {
                    std::ptr::copy_nonoverlapping(response.as_ptr(), buf, needed);
                    *out_len = needed;
                }
                return std::ptr::null_mut();
            }
            alloc_owned_bytes(response, out_len)
        }
    }
}

/// Frame caller-buffer 경로의 dispatch — 패닉 가드 포함, 응답 바이트 반환.
fn frame_dispatch_bytes(bytes: &[u8]) -> Vec<u8> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        get_package()
            .ok_or_else(|| {
                crate::RustraError::custom("ffi.not_registered", "package not registered")
            })
            .and_then(|pkg| pkg.invoke_frame(bytes))
    })) {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => crate::encode_frame_error(&error),
        Err(panic) => {
            crate::encode_frame_error(&crate::RustraError::internal(panic_frame_message(&*panic)))
        }
    }
}
