use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::json;

/// rkyv V2 왕복 버퍼 헤더 — 코어 FFI 레이아웃([ok:1][pad3][len u32 LE][body]).
/// napi Buffer 는 길이를 자체적으로 들고 있으므로 JS 계약과 정확히 맞는다.
mod rkyv_v2 {
    use super::*;

    /// 이미 등록된 calculator 패키지로 postcard(rkyv V2) 프레임을 실행한다.
    /// 요청/응답 모두 코어 rkyv V2 레이아웃 그대로 — JS 측
    /// `createRkyvV2Engine(native, registry)`의 `RkyvV2Native` 계약
    /// (`invokeRkyvV2(payload: ArrayBuffer): ArrayBuffer`)과 짝이 맞다.
    ///
    /// JSON String 왕복(`rustra_invoke`) 대비 UTF-16 복사와 JSON
    /// 직렬화/파싱을 모두 건너뛴다 — 코어 실측 61.5ns vs JSON 1.11µs.
    ///
    /// cargo test 빌드에서 cdylib 진입점이 죽은 코드로 보여 dead_code 경고가
    /// 나지만 napi CLI 가 이 심볼을 JS 로 노출한다.
    #[allow(dead_code)]
    #[napi]
    pub fn rustra_invoke_rkyv_v2(payload: Buffer) -> Result<Buffer> {
        let req: &[u8] = &payload;
        // calculator 패키지 등록 + FFI 컨텍스트를 늘린다(코어 진입 전제).
        rustra_calculator_example::calculator_package();
        let mut out_len: usize = 0;
        // SAFETY: payload 는 napi Buffer 로 JS 힙에 살아 있고 out_len 는 지역
        // 변수다. 반환 포인터는 코어 할당 레이아웃이므로 해제 짝은
        // rustra_ffi_free 다 — 아래에서 즉시 복사 후 해제한다.
        let ptr = unsafe {
            rustra::ffi::rustra_ffi_invoke_rkyv_v2(req.as_ptr(), req.len(), &mut out_len)
        };
        if ptr.is_null() {
            return Err(Error::from_reason("invoke.rkyv_v2: native invoke failed"));
        }
        // SAFETY: ptr/out_len 은 위 호출이 반환한 정확한 짝이다.
        let frame: Vec<u8> = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
        // SAFETY: 코어 할당 버퍼 해제 — Vec 복사 뒤라 이후 접근 없음.
        unsafe { rustra::ffi::rustra_ffi_free(ptr, out_len) };
        Ok(Buffer::from(frame))
    }
}

/// RustraError → napi Error: 코드/retryable 이 유실되지 않도록 JSON 직렬화해
/// reason 에 심는다. JS 측 parseRustraErrorString(@rustra/types)이
/// { code, message, retryable } 을 복원한다 — plain Display(to_string)는
/// "code: message" 로 평탄화되어 retryable 을 버린다.
fn napi_error(e: rustra::RustraError) -> Error {
    let wire = serde_json::to_string(&e).unwrap_or_else(|_| e.to_string());
    Error::from_reason(wire)
}

#[napi]
pub fn rustra_invoke(command: String, args_json: Option<String>) -> Result<String> {
    let args_value = match args_json {
        Some(ref s) => {
            serde_json::from_str(s).map_err(|e| Error::from_reason(format!("invalid args: {e}")))?
        }
        None => json!({}),
    };

    let result = rustra_calculator_example::calculator_package()
        .invoke_json(&command, args_value)
        .map_err(napi_error)?;

    serde_json::to_string(&json!({ "ok": true, "result": result }))
        .map_err(|e| Error::from_reason(format!("json encode: {e}")))
}

/// Buffer 반환 변형 — String 왕복의 이중 할당(napi가 UTF-16 문자열로 복사)을
/// 피한다. transport-bench 측정에서 napi 브릿지 오버헤드의 대부분이 이 복사라
/// 대형 응답(스키마, 배열) 경로에서 유의미하다. 프레임 형식은 rustra_invoke 와
/// 동일한 JSON — JS 측에서 Buffer.toString()/직접 파싱 어느 쪽이든 소비 가능.
#[napi]
pub fn rustra_invoke_buffer(command: String, args_json: Option<String>) -> Result<Buffer> {
    let args_value = match args_json {
        Some(ref s) => {
            serde_json::from_str(s).map_err(|e| Error::from_reason(format!("invalid args: {e}")))?
        }
        None => json!({}),
    };

    let result = rustra_calculator_example::calculator_package()
        .invoke_json(&command, args_value)
        .map_err(napi_error)?;

    let frame = serde_json::to_vec(&json!({ "ok": true, "result": result }))
        .map_err(|e| Error::from_reason(format!("json encode: {e}")))?;
    Ok(Buffer::from(frame))
}
