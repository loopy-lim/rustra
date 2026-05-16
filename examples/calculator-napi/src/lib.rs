use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::json;

#[napi]
pub fn rustra_invoke(command: String, args_json: Option<String>) -> Result<String> {
    let args_value = match args_json {
        Some(ref s) => serde_json::from_str(s)
            .map_err(|e| Error::from_reason(format!("invalid args: {e}")))?,
        None => json!({}),
    };

    let result = rustra_calculator_example::calculator_package()
        .invoke_json(&command, args_value)
        .map_err(|e| Error::from_reason(e.to_string()))?;

    serde_json::to_string(&json!({ "ok": true, "result": result }))
        .map_err(|e| Error::from_reason(format!("json encode: {e}")))
}
