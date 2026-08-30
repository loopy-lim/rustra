/// rkyv V2 에러를 postcard 가 아닌 코어 에러 인코더로 감싸는 serialize 어댑터 —
/// `run_worker`/`deliver_spawn_failure` 는 `fn(&FfiResponse) -> Vec<u8>` 를
/// 기대하지만 rkyv V2 경로는 RustraError 를 직접 인코딩한다. 에러 문자열을
/// FfiResponse.error 에 실으면 수신측(JSON 파서)이 아니라 rkyv V2 디코더가
/// 읽는다 — run_worker 는 `invoke_fn` 이 반환한 버퍼를 그대로 on_complete 로
/// 전달하므로 이 어댑터는 에러 프레임만 만들면 된다.
fn rkyv_error_bytes(resp: &FfiResponse) -> Vec<u8> {
    let raw = resp.error.as_deref().unwrap_or("invoke failed");
    let (code, message) = raw
        .split_once(": ")
        .map_or(("invoke.failed", raw), |(code, message)| (code, message));
    // FFI Display 문자열을 rkyv typed error로 다시 만들 때 안정 코드와
    // retryable 기본 의미를 보존한다. 임의 사용자 코드는 &'static str 계약상
    // 재구성할 수 없으므로 invoke.failed로 안전하게 폴백한다.
    let error = match code {
        "cancelled" => crate::RustraError::cancelled(message),
        "transport.error" => crate::RustraError::transport(message),
        "transport.timeout" => crate::RustraError::timeout(message),
        "command.not_found" => crate::RustraError::custom("command.not_found", message),
        "command.invalid_args" => crate::RustraError::custom("command.invalid_args", message),
        "capability.denied" => crate::RustraError::custom("capability.denied", message),
        "payload.too_large" => crate::RustraError::custom("payload.too_large", message),
        "internal" => crate::RustraError::internal(message),
        "invoke.backpressure" => {
            crate::RustraError::custom("invoke.backpressure", message).retryable()
        }
        _ => crate::RustraError::custom("invoke.failed", raw),
    };
    crate::encode_rkyv_v2_error(&error)
}
///
/// # Safety
///
/// `out_len` must be a valid, non-null write pointer (a null `out_len` returns a
/// null pointer rather than dereferencing). Caller must free the returned buffer
/// with `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_get_schema(out_len: *mut usize) -> *mut u8 {
    if out_len.is_null() {
        return std::ptr::null_mut();
    }
    match get_package() {
        Some(pkg) => {
            let json = serde_json::to_vec(&pkg.live_schema()).unwrap_or_else(|_| b"{}".to_vec());
            alloc_response(json, out_len)
        }
        None => alloc_response(b"{}".to_vec(), out_len),
    }
}

/// 현재 등록된 패키지의 **계약 해시** (SHA-256 hex) 를 UTF-8 바이트로 반환한다.
///
/// `live_schema()` 를 `serde_json::to_string_pretty` 로 직렬화한 뒤 해시한다 — 이는
/// 빌드 시점 `generate_typescript()` → `contract.ts` 의 `GENERATED_CONTRACT_HASH` 와
/// 동일한 입력/알고리즘이므로 양쪽 값이 일치해야 한다. 호스트(TS 엔진)는 이 값을
/// `contractHash` 옵션(F5) 과 비교해 스키마 드리프트를 런타임에 검증한다.
/// 패키지가 미등록이면 빈 문자열을 반환한다.
///
/// 반환 버퍼는 `rustra_ffi_free` 로 해제.
///
/// # Safety
///
/// `out_len` must be a valid, non-null write pointer. Caller must free the
/// returned buffer with `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_contract_hash(out_len: *mut usize) -> *mut u8 {
    if out_len.is_null() {
        return std::ptr::null_mut();
    }
    let hex = match get_package() {
        Some(pkg) => {
            let json = serde_json::to_string_pretty(&pkg.live_schema()).unwrap_or_default();
            crate::codegen::contract_hash(json)
        }
        None => String::new(),
    };
    alloc_response(hex.into_bytes(), out_len)
}

/// (T0) 현재 스키마 세대를 u64 로 반환한다 — read lock 1회 + 복사. 동적 명령
/// 캐시를 가진 호스트가 호출 전후로 비교해 치환(replace/unregister) 여부를
/// 감지하고, 불일치 시 `rustra_ffi_get_schema` 로 재동기화한다. 패키지가
/// 미등록이면 0 을 반환한다.
///
/// # Safety
///
/// 진입점 자체는 포인터 인자를 갖지 않는다(값 반환).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_schema_generation() -> u64 {
    match get_package() {
        Some(pkg) => pkg.schema_generation(),
        None => 0,
    }
}

// -- Event sink (push delivery) ------------------------------------------

/// C 호스트가 `rustra_ffi_event_sink_register` 로 등록하는 콜백 원형.
///
/// `user_data` 는 등록 시 호스트가 넢긴 포인터 그대로, `name`/`payload` 는
/// NUL 종료 UTF-8 C 문자열(호출 기간에만 유효 — 필요하면 복사).
///
/// ABI 는 `extern "C-unwind"` 다 — 콜백이 되감기(unwind)를 일으킬 수 있음을
/// 명시한다. Rust `catch_unwind` 이 콜백 패닉을 가둬 emit 호출자를 보호하는
/// 계약([`events::EventSink`] 의 패닉 격리)과 짝을 이룬다. 순수 C 호스트는
/// 되감기를 일으키지 않으므로 그대로 동작한다.
pub type FfiEventCallback = unsafe extern "C-unwind" fn(
    user_data: *mut c_void,
    name: *const c_char,
    payload: *const c_char,
);
