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
