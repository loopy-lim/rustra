/// caller-buffer 경로의 dispatch — payload 검사/디코딩/패닉 가드를
/// `rustra_ffi_invoke_json` 과 동일하게 수행하고 응답 바이트를 반환한다.
fn dispatch_into_bytes(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(bytes.len(), max_payload_bytes());
        return json_serialize(&err_frame(&e.to_string()));
    }
    match json_deserialize_envelope(bytes) {
        Ok(env) => {
            // 패닉 가드는 기존 경로와 동일(`with_panic_guard` 와 같은 메시지
            // 포맷) — dispatch_json 이 패닉하면 에러 프레임으로 변환한다.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                dispatch_json(&env.command, env.args)
            }));
            match result {
                Ok(resp) => json_serialize(&resp),
                Err(panic) => json_serialize(&err_frame(&panic_frame_message(panic.as_ref()))),
            }
        }
        Err(e) => json_serialize(&err_frame(&e)),
    }
}

/// 에러 응답 프레임 직렬화 공용 헬퍼 — `err_response` 는 FFI 버퍼 할당 경로라
/// caller-buffer 에서는 이 헬퍼로 대체한다.
fn err_frame(msg: &str) -> FfiResponse {
    FfiResponse {
        ok: false,
        result: None,
        error: Some(msg.to_string()),
    }
}

/// 패닉을 단일 포맷의 에러 프레임 메시지로 정규화한다 — `with_panic_guard` 와
/// caller-buffer 경로가 공유한다. 호스트 측 파서가 prefix 로 분류하므로 포맷이
/// 경로별로 갈라지면 안 된다 (과거 "internal: panic — …" / "panic in handler: …"
/// 두 종류가 공존했다).
fn panic_frame_message(payload: &(dyn std::any::Any + Send)) -> String {
    format!("internal: panic — {}", panic_message(payload))
}

/// caller-buffer size-probe 결과의 1회 실행 캐시.
///
/// probe(buf=null) → write(buf) 2단계 프로토콜에서 각 단계가 dispatch 를
/// 재실행하면 비멱등 핸들러(카운터 증가, 결제)의 사이드 이펙트가 2번 발생한다.
/// probe 가 직렬화한 응답을 여기 보관하면 이어지는 write 호출이 dispatch 없이
/// 같은 바이트를 caller 버퍼에 복사한다. 단일 호출 흐름(probe 직후 write)을
/// 전제로 마지막 1건만 보관한다 — probe 후 다른 명령을 probe 하면 이전 캐시는
/// 덮어써진다(잘못된 응답 재사용 없음).
///
/// 보관된 probe 결과를 꺼낸다(소비). 해시가 아니라 요청 바이트 전체를 비교해
/// 충돌로 다른 명령의 응답이 전달될 가능성을 없앤다. JSON/rkyv V2 슬롯도
/// 분리해 한 API의 probe가 다른 API의 캐시를 덮어쓰지 않는다.
struct ProbeCacheEntry {
    request: Vec<u8>,
    response: Vec<u8>,
}

fn probe_cache_take(
    cache: &'static std::thread::LocalKey<std::cell::RefCell<Option<ProbeCacheEntry>>>,
    payload: &[u8],
) -> Option<Vec<u8>> {
    cache.with(|slot| {
        let entry = slot.borrow_mut().take()?;
        (entry.request == payload).then_some(entry.response)
    })
}

fn probe_cache_store(
    cache: &'static std::thread::LocalKey<std::cell::RefCell<Option<ProbeCacheEntry>>>,
    payload: &[u8],
    response: Vec<u8>,
) {
    cache.with(|slot| {
        *slot.borrow_mut() = Some(ProbeCacheEntry {
            request: payload.to_vec(),
            response,
        });
    });
}

fn json_probe_cache_take(payload: &[u8]) -> Option<Vec<u8>> {
    probe_cache_take(&JSON_PROBE_CACHE, payload)
}

fn json_probe_cache_store(payload: &[u8], response: Vec<u8>) {
    probe_cache_store(&JSON_PROBE_CACHE, payload, response);
}

fn rkyv_probe_cache_take(payload: &[u8]) -> Option<Vec<u8>> {
    probe_cache_take(&RKYV_V2_PROBE_CACHE, payload)
}

fn rkyv_probe_cache_store(payload: &[u8], response: Vec<u8>) {
    probe_cache_store(&RKYV_V2_PROBE_CACHE, payload, response);
}

thread_local! {
    static JSON_PROBE_CACHE: std::cell::RefCell<Option<ProbeCacheEntry>> = const { std::cell::RefCell::new(None) };
    static RKYV_V2_PROBE_CACHE: std::cell::RefCell<Option<ProbeCacheEntry>> = const { std::cell::RefCell::new(None) };
}

/// Postcard binary path.
///
/// Request:  postcard-encoded `{ command: String, args_json: String }`.
///           `args_json` is a JSON-encoded string of the command arguments.
/// Response: postcard-encoded `{ ok: bool, result_json: Option<String>, error: Option<String> }`.
///           `result_json` is a JSON-encoded string of the command result.
///
/// # Safety
///
/// Same as [`rustra_ffi_invoke`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_postcard(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    if payload_len > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        return err_response(&e.to_string(), out_len, postcard_serialize_response);
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let (command, args) = match postcard_deserialize_envelope(bytes) {
        Ok(tuple) => tuple,
        Err(e) => return err_response(&e, out_len, postcard_serialize_response),
    };

    with_panic_guard(out_len, postcard_serialize_response, || {
        dispatch_json(&command, args)
    })
}
