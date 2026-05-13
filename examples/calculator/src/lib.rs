use rustra::prelude::*;
use serde_json::{Value, json};
use std::ffi::{CStr, CString, c_char};

const MAX_PAYLOAD_BYTES: usize = 1024 * 1024; // 1 MB

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersInput {
    pub a: i64,
    pub b: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AddNumbersOutput {
    pub value: i64,
}

#[command]
pub fn add_numbers(input: AddNumbersInput) -> Result<AddNumbersOutput> {
    Ok(AddNumbersOutput {
        value: input.a + input.b,
    })
}

pub fn calculator_package() -> Package {
    register!(Package::builder("examples.calculator"), add_numbers).build()
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke(payload: *const c_char) -> *mut c_char {
    if payload.is_null() {
        return json_string(json!({ "ok": false, "error": "payload was null" }));
    }

    let payload = match unsafe { CStr::from_ptr(payload) }.to_str() {
        Ok(payload) => payload,
        Err(error) => {
            return json_string(
                json!({ "ok": false, "error": format!("payload was not UTF-8: {error}") }),
            );
        }
    };

    if payload.len() > MAX_PAYLOAD_BYTES {
        return json_string(json!({ "ok": false, "error": "payload exceeds size limit" }));
    }

    let request = match serde_json::from_str::<Value>(payload) {
        Ok(request) => request,
        Err(error) => {
            return json_string(json!({ "ok": false, "error": format!("invalid json: {error}") }));
        }
    };

    let Some(command) = request.get("command").and_then(Value::as_str) else {
        return json_string(json!({ "ok": false, "error": "missing command" }));
    };

    let args = request.get("args").cloned().unwrap_or_else(|| json!({}));

    match calculator_package().invoke_json(command, args) {
        Ok(result) => json_string(json!({ "ok": true, "result": result })),
        Err(error) => json_string(json!({ "ok": false, "error": error.to_string() })),
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = unsafe { CString::from_raw(ptr) };
    }
}

fn json_string(value: Value) -> *mut c_char {
    let text = serde_json::to_string(&value)
        .unwrap_or_else(|error| format!(r#"{{"ok":false,"error":"json encode failed: {error}"}}"#));

    CString::new(text)
        .expect("JSON response should not contain interior null bytes")
        .into_raw()
}
