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

/// # Safety
///
/// `payload` must be a valid pointer to a null-terminated C string containing UTF-8 JSON.
/// The caller must free the returned pointer with `rustra_calculator_free_string`.
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

/// # Safety
///
/// `ptr` must be a pointer previously returned by `rustra_calculator_invoke`,
/// or null. Must not be called more than once for the same pointer.
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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_bytes(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    if payload_len > MAX_PAYLOAD_BYTES {
        let error = format!(r#"{{"ok":false,"error":"payload exceeds size limit"}}"#);
        return alloc_response(error.into_bytes(), out_len);
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let payload_str = match std::str::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => {
            let error = format!(r#"{{"ok":false,"error":"payload was not UTF-8: {e}"}}"#);
            return alloc_response(error.into_bytes(), out_len);
        }
    };

    let c_payload = match CString::new(payload_str) {
        Ok(c) => c,
        Err(_) => {
            let error = r#"{"ok":false,"error":"payload contained null byte"}"#;
            return alloc_response(error.as_bytes().to_vec(), out_len);
        }
    };

    let result_ptr = unsafe { rustra_calculator_invoke(c_payload.as_ptr()) };
    let result_cstr = unsafe { std::ffi::CStr::from_ptr(result_ptr) };
    let result_bytes = result_cstr.to_bytes().to_vec();
    unsafe { rustra_calculator_free_string(result_ptr) };

    alloc_response(result_bytes, out_len)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_free_buffer(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        unsafe {
            let slice = std::slice::from_raw_parts_mut(ptr, len);
            let _ = Box::from_raw(slice as *mut [u8]);
        }
    }
}

fn alloc_response(data: Vec<u8>, out_len: *mut usize) -> *mut u8 {
    unsafe { *out_len = data.len() };
    let boxed: Box<[u8]> = data.into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_invoke_bytes_round_trip() {
        let input = r#"{"command":"addNumbers","args":{"a":42,"b":58}}"#;
        let payload = input.as_bytes();
        let mut out_len: usize = 0;

        let result_ptr = unsafe {
            rustra_calculator_invoke_bytes(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let result_str = std::str::from_utf8(result_bytes).unwrap();
        let result: serde_json::Value = serde_json::from_str(result_str).unwrap();

        assert_eq!(result["ok"], true);
        assert_eq!(result["result"]["value"], 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_invoke_bytes_null_payload() {
        let mut out_len: usize = 0;
        let result = unsafe { rustra_calculator_invoke_bytes(std::ptr::null(), 0, &mut out_len) };
        assert!(result.is_null());
    }

    #[test]
    fn test_invoke_bytes_bad_json() {
        let payload = b"not json";
        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_bytes(payload.as_ptr(), payload.len(), &mut out_len)
        };
        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let result_str = std::str::from_utf8(result_bytes).unwrap();
        assert!(result_str.contains(r#""ok":false"#));
        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }
}
