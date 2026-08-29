fn err_response(msg: &str, out_len: *mut usize, serialize: fn(&FfiResponse) -> Vec<u8>) -> *mut u8 {
    let resp = FfiResponse {
        ok: false,
        result: None,
        error: Some(msg.to_string()),
    };
    alloc_response(serialize(&resp), out_len)
}

/// 패닉 페이로드에서 사람이 읽을 수 있는 메시지를 추출한다.
pub(crate) fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&'static str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

/// FFI 경계에서 패닉을 가두어 에러 응답으로 변환한다.
///
/// Rust FFI 규칙: 패닉은 절대 `extern "C"` 경계를 넘어서는 안 된다.
/// 넘으면 정의되지 않은 동작(UB) 이거나 호스트 프로세스 abort 를 유발한다.
/// 이 함수는 핸들러/직렬화 중 발생한 패닉을 잡아
/// `FfiResponse { ok:false, error:"internal: panic — ..." }` 로 정규화한다.
///
/// `out_len` 은 호출 전에 non-null 임이 보장되어야 한다 (extern 엔트리에서 선제 검사).
fn with_panic_guard<F>(
    out_len: *mut usize,
    serialize: fn(&FfiResponse) -> Vec<u8>,
    body: F,
) -> *mut u8
where
    F: FnOnce() -> FfiResponse,
{
    // AssertUnwindSafe: body 가 캡처한 값(envelope) 은 패닉 후 다시 사용되지 않으므로
    // unwind-safety 가 요구되지 않는다 — 응답만 반환한다.
    let resp = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(body)) {
        Ok(resp) => resp,
        Err(payload) => FfiResponse {
            ok: false,
            result: None,
            error: Some(panic_frame_message(&*payload)),
        },
    };
    alloc_response(serialize(&resp), out_len)
}

fn dispatch_json(command: &str, args: serde_json::Value) -> FfiResponse {
    match get_package() {
        Some(pkg) => match pkg.invoke_json(command, args) {
            Ok(result) => FfiResponse {
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(e) => FfiResponse {
                ok: false,
                result: None,
                error: Some(e.to_string()),
            },
        },
        None => FfiResponse {
            ok: false,
            result: None,
            error: Some("no package registered — call register_ffi() first".into()),
        },
    }
}

// -- JSON serialization helpers ------------------------------------------

fn json_serialize(resp: &FfiResponse) -> Vec<u8> {
    serde_json::to_vec(resp)
        .unwrap_or_else(|_| b"{\"ok\":false,\"error\":\"json encode failed\"}".to_vec())
}

fn json_deserialize_envelope(bytes: &[u8]) -> Result<FfiEnvelope, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("json decode failed: {e}"))
}

// -- Postcard serialization helpers --------------------------------------

fn postcard_serialize_response(resp: &FfiResponse) -> Vec<u8> {
    let pc_resp = FfiPostcardResponse {
        ok: resp.ok,
        result_json: resp
            .result
            .as_ref()
            .map(|v| serde_json::to_string(v).unwrap_or_default()),
        error: resp.error.clone(),
    };
    postcard::to_allocvec(&pc_resp).unwrap_or_default()
}

fn postcard_deserialize_envelope(bytes: &[u8]) -> Result<(String, serde_json::Value), String> {
    let env: FfiPostcardEnvelope =
        postcard::from_bytes(bytes).map_err(|e| format!("postcard decode failed: {e}"))?;
    let args: serde_json::Value =
        serde_json::from_str(&env.args_json).unwrap_or(serde_json::Value::Null);
    Ok((env.command, args))
}
