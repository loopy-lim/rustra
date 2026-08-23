use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::json;

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
