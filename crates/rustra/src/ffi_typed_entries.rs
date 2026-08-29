/// rkyv V2 바이너리 와이어 진입점 — command_id(u16) 기반 dispatch.
///
/// 소비자마다 패닉 가드+버퍼 프로토콜을 복제해 구현하던 것(examples/calculator 의
/// `rustra_calculator_invoke_rkyv_v2` 등)을 코어가 대신 제공한다. 응답은
/// [`crate::encode_rkyv_v2_error`] 와 동일한 와이어(성공 시 ok=1 + postcard body).
/// 패닉은 `with_panic_guard` 계약대로 internal 에러 프레임으로 정규화된다.
///
/// # Safety
///
/// `payload` must point to at least `payload_len` readable bytes.
/// `out_len` must be a valid write pointer.
/// Caller must free the returned buffer with `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_rkyv_v2(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };
    // 패닉 가드는 한 겹이다 — 코어 invoke_rkyv_v2_command 가 핸들러 패닉을
    // internal 에러로 정규화한다. 이전의 바깥 catch_unwind 은 같은 패닉을
    // 두 번 가두며 unwind 테이블 세팅 비용만 핫패스에 남겼다. 레지스트리
    // 조회(BTreeMap get)와 슬라이스 생성은 패닉 불가능한 코어 제어 코드다.
    let resp = match get_package()
        .ok_or_else(|| crate::RustraError::custom("ffi.not_registered", "package not registered"))
        .and_then(|pkg| pkg.invoke_rkyv_v2(bytes))
    {
        Ok(bytes) => bytes,
        Err(error) => crate::encode_rkyv_v2_error(&error),
    };
    alloc_response(resp, out_len)
}

/// Direct single-byte-field invocation. Success transfers the handler's owned
/// output vector without a postcard response frame; errors transfer a UTF-8
/// `RustraError` display string. Return value: 0 success, 1 command error,
/// `u32::MAX` invalid ABI arguments.
///
/// # Safety
///
/// - `payload` must be readable for `payload_len` bytes, or null when len is 0.
/// - `out_ptr` and `out_len` must be valid writable pointers.
/// - the returned pair must be freed with `rustra_ffi_free_owned_bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_buffer(
    command_id: u16,
    payload: *const u8,
    payload_len: usize,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
) -> u32 {
    if out_ptr.is_null() || out_len.is_null() || (payload.is_null() && payload_len != 0) {
        return u32::MAX;
    }
    unsafe {
        *out_ptr = std::ptr::null_mut();
        *out_len = 0;
    }
    let bytes = if payload_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len) }
    };
    let result = get_package()
        .ok_or_else(|| crate::RustraError::custom("ffi.not_registered", "package not registered"))
        .and_then(|package| package.invoke_buffer(command_id, bytes));
    let (status, output) = match result {
        Ok(output) => (0, output),
        Err(error) => (1, error.to_string().into_bytes()),
    };
    let ptr = alloc_owned_bytes(output, out_len);
    unsafe { *out_ptr = ptr };
    status
}

/// Return 1 when the registered package owns a direct handler for `command_id`.
#[unsafe(no_mangle)]
pub extern "C" fn rustra_ffi_has_buffer(command_id: u16) -> u32 {
    u32::from(get_package().is_some_and(|package| package.has_buffer_handler(command_id)))
}

/// 스칼라 직결(raw) invoke — postcard 인코딩/디코딩 없이 u64 슬롯으로 주고받는다.
///
/// JSI 호스트의 `invokeTypedRaw(cmdId, ...args)` 진입과 짝을 이룬다. 슬롯
/// 배열은 인자 선언순 그대로(f64는 IEEE-754 비트 재해석, bool은 0/1). 결과
/// 슬롯은 `out_slot` 에 기록되고 반환값은 에러 코드다(0=성공, 그 외=에러).
/// 에러 상세는 기존 rkyv V2 에러 와이어([`crate::encode_rkyv_v2_error`])를
/// `err_buf`/`err_buf_cap` 에 복사하고 필요 크기를 `err_len` 에 쓴다 —
/// 부족하면 잘린 메시지라도 싣고 0이 아닌 코드를 반환한다.
///
/// 명령이 raw 조건(스칼라 1..3 입력 + 단일 스칼라/unit 출력)이 아니면
/// `u32::MAX`(폴백 신호)를 반환한다 — 호스트는 by-id 경로로 되돌린다.
///
/// # Safety
///
/// `slots` must point to at least `slot_count` readable u64 values.
/// `out_slot` and `err_len` must be valid write pointers.
/// `err_buf`, when non-null, must point to at least `err_buf_cap` writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_raw(
    command_id: u16,
    slots: *const u64,
    slot_count: usize,
    out_slot: *mut u64,
    err_buf: *mut u8,
    err_buf_cap: usize,
    err_len: *mut usize,
) -> u32 {
    if out_slot.is_null() || err_len.is_null() {
        return u32::MAX;
    }
    let Some(pkg) = get_package() else {
        unsafe { *err_len = 0 };
        return u32::MAX;
    };
    // raw 직결 불가 명령 폴백 신호 — 호스트가 by-id 경로로 되돌린다.
    if pkg.raw_invoke_shape(command_id).is_none() {
        unsafe { *err_len = 0 };
        return u32::MAX;
    }
    let slot_slice: &[u64] = if slots.is_null() || slot_count == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(slots, slot_count) }
    };
    match pkg.invoke_raw(command_id, slot_slice) {
        Ok(value) => {
            unsafe { *out_slot = value };
            unsafe { *err_len = 0 };
            0
        }
        Err(error) => {
            let wire = crate::encode_rkyv_v2_error(&error);
            let needed = wire.len();
            let copy = needed.min(err_buf_cap);
            if !err_buf.is_null() && copy > 0 {
                unsafe {
                    std::ptr::copy_nonoverlapping(wire.as_ptr(), err_buf, copy);
                }
            }
            unsafe { *err_len = needed };
            1
        }
    }
}
