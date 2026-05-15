use rustra::prelude::*;
use serde_json::{json, Value};
use std::ffi::{c_char, CStr, CString};

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

// ── Tier 1 추가 명령 ──────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MultiplyInput {
    pub a: f64,
    pub b: f64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MultiplyOutput {
    pub value: f64,
}

#[command]
pub fn multiply(input: MultiplyInput) -> Result<MultiplyOutput> {
    Ok(MultiplyOutput {
        value: input.a * input.b,
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IsEvenInput {
    pub n: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IsEvenOutput {
    pub result: bool,
}

#[command]
pub fn is_even(input: IsEvenInput) -> Result<IsEvenOutput> {
    Ok(IsEvenOutput {
        result: input.n % 2 == 0,
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClampInput {
    pub max: f64,
    pub min: f64,
    pub value: f64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClampOutput {
    pub value: f64,
}

#[command]
pub fn clamp(input: ClampInput) -> Result<ClampOutput> {
    Ok(ClampOutput {
        value: input.value.clamp(input.min, input.max),
    })
}

// Note: ClampInput fields are ordered alphabetically (max, min, value) to match
// schemars JSON Schema output order. Postcard serializes in struct field order.

// ── Tier 2 (String/Vec) 명령 ─────────────────────────────

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GreetInput {
    pub name: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GreetOutput {
    pub message: String,
}

#[command]
pub fn greet(input: GreetInput) -> Result<GreetOutput> {
    Ok(GreetOutput {
        message: format!("Hello, {}!", input.name),
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SumListInput {
    pub numbers: Vec<i64>,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SumListOutput {
    pub count: i32,
    pub total: i64,
}

#[command]
pub fn sum_list(input: SumListInput) -> Result<SumListOutput> {
    Ok(SumListOutput {
        count: input.numbers.len() as i32,
        total: input.numbers.iter().sum(),
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToUpperInput {
    pub s: String,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ToUpperOutput {
    pub result: String,
}

#[command]
pub fn to_upper(input: ToUpperInput) -> Result<ToUpperOutput> {
    Ok(ToUpperOutput {
        result: input.s.to_uppercase(),
    })
}

// ── Tier 3 (중첩 구조체) 명령 ────────────────────────────

#[derive(Debug, Serialize, Deserialize, JsonSchema, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub active: bool,
    pub name: String,
    pub value: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateItemInput {
    pub name: String,
    pub value: i64,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateItemOutput {
    pub item: Item,
}

#[command]
pub fn create_item(input: CreateItemInput) -> Result<CreateItemOutput> {
    Ok(CreateItemOutput {
        item: Item {
            active: true,
            name: input.name,
            value: input.value,
        },
    })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessItemInput {
    pub item: Item,
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcessItemOutput {
    pub doubled: bool,
    pub item: Item,
}

#[command]
pub fn process_item(input: ProcessItemInput) -> Result<ProcessItemOutput> {
    let doubled = input.item.value > 100;
    Ok(ProcessItemOutput {
        doubled,
        item: Item {
            active: input.item.active && doubled,
            name: format!("processed_{}", input.item.name),
            value: input.item.value * 2,
        },
    })
}

pub fn calculator_package() -> Package {
    register!(
        Package::builder("examples.calculator"),
        add_numbers,
        multiply,
        is_even,
        clamp,
        greet,
        sum_list,
        to_upper,
        create_item,
        process_item
    )
    .build()
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

/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
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
        let error = r#"{"ok":false,"error":"payload exceeds size limit"}"#;
        return alloc_response(error.as_bytes().to_vec(), out_len);
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

/// # Safety
///
/// Caller must ensure `ptr` was previously returned by an invoke function and `len` matches the
/// original output length. Must not be called more than once for the same pointer.
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

/// Binary protocol:
///   Request:  [cmd_id: u16 LE] [args...]
///     cmd_id 1 = addNumbers => [a: f64 LE] [b: f64 LE]
///   Response: [ok: u8] [payload...]
///     ok=1 success => [value: f64 LE]
///     ok=0 error   => [err_len: u16 LE] [err bytes...]
///
/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_raw(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || payload_len < 2 || out_len.is_null() {
        let err = b"\x00\x03\x00err";
        return alloc_response(err.to_vec(), out_len);
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };
    let cmd_id = u16::from_le_bytes([bytes[0], bytes[1]]);

    match cmd_id {
        1 => {
            // addNumbers: expects 2 + 8 + 8 = 18 bytes
            if bytes.len() < 18 {
                let err = b"\x00\x10\x00insufficient args";
                return alloc_response(err.to_vec(), out_len);
            }
            let a = f64::from_le_bytes([
                bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7], bytes[8], bytes[9],
            ]);
            let b = f64::from_le_bytes([
                bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15], bytes[16],
                bytes[17],
            ]);
            let result = (a as i64) + (b as i64);
            let mut resp = vec![0x01u8];
            resp.extend_from_slice(&(result as f64).to_le_bytes());
            alloc_response(resp, out_len)
        }
        _ => {
            let msg = format!("unknown cmd_id: {cmd_id}");
            let mut resp = vec![0x00u8];
            let msg_bytes = msg.as_bytes();
            resp.extend_from_slice(&(msg_bytes.len() as u16).to_le_bytes());
            resp.extend_from_slice(msg_bytes);
            alloc_response(resp, out_len)
        }
    }
}

/// MessagePack-encoded FFI: same request/response structure as JSON, but msgpack.
/// Request:  msgpack({ command: String, args: Value })
/// Response: msgpack({ ok: bool, result: Option<Value>, error: Option<String> })
///
/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_msgpack(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let request: serde_json::Value = match rmp_serde::from_slice(bytes) {
        Ok(req) => req,
        Err(e) => {
            let resp =
                serde_json::json!({"ok": false, "error": format!("msgpack decode failed: {e}")});
            let resp_bytes = rmp_serde::to_vec(&resp).unwrap_or_default();
            return alloc_response(resp_bytes, out_len);
        }
    };

    let Some(command) = request.get("command").and_then(|v| v.as_str()) else {
        let resp = serde_json::json!({"ok": false, "error": "missing command"});
        let resp_bytes = rmp_serde::to_vec(&resp).unwrap_or_default();
        return alloc_response(resp_bytes, out_len);
    };

    let args = request
        .get("args")
        .cloned()
        .unwrap_or(serde_json::json!({}));

    let result = match calculator_package().invoke_json(command, args) {
        Ok(result) => serde_json::json!({"ok": true, "result": result}),
        Err(error) => serde_json::json!({"ok": false, "error": error.to_string()}),
    };

    let resp_bytes = rmp_serde::to_vec(&result).unwrap_or_default();
    alloc_response(resp_bytes, out_len)
}

/// Bincode-encoded FFI using typed structs (bincode can't handle serde_json::Value).
#[derive(Serialize, Deserialize)]
struct BincodeRequest {
    command: String,
    a: i64,
    b: i64,
}

#[derive(Serialize, Deserialize)]
struct BincodeResponse {
    ok: bool,
    value: i64,
    error: Option<String>,
}

/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_bincode(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let request: BincodeRequest =
        match bincode::serde::decode_from_slice(bytes, bincode::config::standard()) {
            Ok((req, _)) => req,
            Err(e) => {
                let resp = BincodeResponse {
                    ok: false,
                    value: 0,
                    error: Some(format!("bincode decode failed: {e}")),
                };
                let resp_bytes = bincode::serde::encode_to_vec(&resp, bincode::config::standard())
                    .unwrap_or_default();
                return alloc_response(resp_bytes, out_len);
            }
        };

    let result = match calculator_package().invoke_json(
        &request.command,
        serde_json::json!({"a": request.a, "b": request.b}),
    ) {
        Ok(result) => {
            let value = result.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
            BincodeResponse {
                ok: true,
                value,
                error: None,
            }
        }
        Err(error) => BincodeResponse {
            ok: false,
            value: 0,
            error: Some(error.to_string()),
        },
    };

    let resp_bytes =
        bincode::serde::encode_to_vec(&result, bincode::config::standard()).unwrap_or_default();
    alloc_response(resp_bytes, out_len)
}

/// Postcard-encoded FFI (serde-compatible, actively maintained bincode alternative).
///
/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_postcard(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let request: BincodeRequest = match postcard::from_bytes(bytes) {
        Ok(req) => req,
        Err(e) => {
            let resp = BincodeResponse {
                ok: false,
                value: 0,
                error: Some(format!("postcard decode failed: {e}")),
            };
            let resp_bytes = postcard::to_allocvec(&resp).unwrap_or_default();
            return alloc_response(resp_bytes, out_len);
        }
    };

    let result = match calculator_package().invoke_json(
        &request.command,
        serde_json::json!({"a": request.a, "b": request.b}),
    ) {
        Ok(result) => {
            let value = result.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
            BincodeResponse {
                ok: true,
                value,
                error: None,
            }
        }
        Err(error) => BincodeResponse {
            ok: false,
            value: 0,
            error: Some(error.to_string()),
        },
    };

    let resp_bytes = postcard::to_allocvec(&result).unwrap_or_default();
    alloc_response(resp_bytes, out_len)
}

/// rkyv-encoded FFI (zero-copy deserialization).
#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
struct RkyvRequest {
    command: String,
    a: i64,
    b: i64,
}

#[derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize)]
struct RkyvResponse {
    ok: bool,
    value: i64,
    error: Option<String>,
}

/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_rkyv(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let archived = match rkyv::access::<ArchivedRkyvRequest, rkyv::rancor::Error>(bytes) {
        Ok(a) => a,
        Err(_) => {
            let resp = RkyvResponse {
                ok: false,
                value: 0,
                error: Some("rkyv access failed".into()),
            };
            let resp_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&resp).unwrap_or_default();
            return alloc_response(resp_bytes.to_vec(), out_len);
        }
    };

    let command = archived.command.to_string();
    let a: i64 = archived.a.into();
    let b: i64 = archived.b.into();

    let result =
        match calculator_package().invoke_json(&command, serde_json::json!({"a": a, "b": b})) {
            Ok(result) => {
                let value = result.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
                RkyvResponse {
                    ok: true,
                    value,
                    error: None,
                }
            }
            Err(error) => RkyvResponse {
                ok: false,
                value: 0,
                error: Some(error.to_string()),
            },
        };

    let resp_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&result).unwrap_or_default();
    alloc_response(resp_bytes.to_vec(), out_len)
}

/// Hybrid FFI: postcard-encoded request, rkyv-encoded response.
/// Best of both worlds — simple TS-side encoding (LEB128), fast Rust-side response (zero-copy rkyv).
///
/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_hybrid(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let request: BincodeRequest = match postcard::from_bytes(bytes) {
        Ok(req) => req,
        Err(e) => {
            let resp = RkyvResponse {
                ok: false,
                value: 0,
                error: Some(format!("hybrid decode failed: {e}")),
            };
            let resp_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&resp).unwrap_or_default();
            return alloc_response(resp_bytes.to_vec(), out_len);
        }
    };

    let result = match calculator_package().invoke_json(
        &request.command,
        serde_json::json!({"a": request.a, "b": request.b}),
    ) {
        Ok(result) => {
            let value = result.get("value").and_then(|v| v.as_i64()).unwrap_or(0);
            RkyvResponse {
                ok: true,
                value,
                error: None,
            }
        }
        Err(error) => RkyvResponse {
            ok: false,
            value: 0,
            error: Some(error.to_string()),
        },
    };

    let resp_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&result).unwrap_or_default();
    alloc_response(resp_bytes.to_vec(), out_len)
}

/// rkyv v2: command_id (u16) based request — generic dispatch via Package::invoke_rkyv_v2()
///
/// # Safety
///
/// Caller must ensure `payload` is valid for `payload_len` bytes and `out_len` is a valid pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_calculator_invoke_rkyv_v2(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let resp_bytes = match calculator_package().invoke_rkyv_v2(bytes) {
        Ok(bytes) => bytes,
        Err(error) => rustra::encode_rkyv_v2_error(&error.to_string()),
    };

    alloc_response(resp_bytes, out_len)
}

#[cfg(test)]
#[cfg(test)]
#[allow(clippy::bool_assert_comparison, clippy::useless_vec)]
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

    #[test]
    fn test_invoke_raw_add_numbers() {
        let mut payload = vec![0u8; 18]; // need Vec for .as_ptr() + dynamic len
        payload[0] = 0x01; // cmd_id = 1 (addNumbers)
        payload[1] = 0x00;
        payload[2..10].copy_from_slice(&42f64.to_le_bytes());
        payload[10..18].copy_from_slice(&58f64.to_le_bytes());

        let mut out_len: usize = 0;
        let result_ptr =
            unsafe { rustra_calculator_invoke_raw(payload.as_ptr(), payload.len(), &mut out_len) };

        assert!(!result_ptr.is_null());
        assert_eq!(out_len, 9); // ok(1) + f64(8)

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 0x01); // ok
        let value = f64::from_le_bytes(result_bytes[1..9].try_into().unwrap());
        assert_eq!(value as i64, 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_invoke_bincode_round_trip() {
        let request = BincodeRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let payload = bincode::serde::encode_to_vec(&request, bincode::config::standard()).unwrap();

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_bincode(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let result: BincodeResponse =
            bincode::serde::decode_from_slice(result_bytes, bincode::config::standard())
                .unwrap()
                .0;

        assert_eq!(result.ok, true);
        assert_eq!(result.value, 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_bincode_wire_bytes() {
        // ── Field-by-field encoding ─────────────────
        let bool_true: bool = true;
        let b = bincode::serde::encode_to_vec(bool_true, bincode::config::standard()).unwrap();
        println!(
            "bool(true)  hex: {}",
            b.iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let val_100: i64 = 100;
        let b = bincode::serde::encode_to_vec(val_100, bincode::config::standard()).unwrap();
        println!(
            "i64(100)    hex: {}",
            b.iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let val_0: i64 = 0;
        let b = bincode::serde::encode_to_vec(val_0, bincode::config::standard()).unwrap();
        println!(
            "i64(0)      hex: {}",
            b.iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let val_42: i64 = 42;
        let b = bincode::serde::encode_to_vec(val_42, bincode::config::standard()).unwrap();
        println!(
            "i64(42)     hex: {}",
            b.iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let val_58: i64 = 58;
        let b = bincode::serde::encode_to_vec(val_58, bincode::config::standard()).unwrap();
        println!(
            "i64(58)     hex: {}",
            b.iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        // Larger values to understand varint scheme
        for v in [127i64, 128, 255, 256, 1000, 10000, -1, -42] {
            let b = bincode::serde::encode_to_vec(v, bincode::config::standard()).unwrap();
            let hex: Vec<String> = b.iter().map(|x| format!("{:02x}", x)).collect();
            let zz = if v >= 0 { v * 2 } else { (-v) * 2 - 1 };
            println!(
                "i64({:>6}) zigzag={:>6} → {} bytes: {}",
                v,
                zz,
                b.len(),
                hex.join(" ")
            );
        }

        let opt_none: Option<String> = None;
        let b = bincode::serde::encode_to_vec(&opt_none, bincode::config::standard()).unwrap();
        println!(
            "Opt<Str>None hex: {}",
            b.iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let opt_some: Option<String> = Some("err".to_string());
        let b = bincode::serde::encode_to_vec(&opt_some, bincode::config::standard()).unwrap();
        println!(
            "Opt<Str>Some hex: {}",
            b.iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let s = "addNumbers".to_string();
        let b = bincode::serde::encode_to_vec(&s, bincode::config::standard()).unwrap();
        println!(
            "String(\"addNumbers\") hex: {}",
            b.iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        // ── Full structs ────────────────────────────
        let request = BincodeRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let req_bytes =
            bincode::serde::encode_to_vec(&request, bincode::config::standard()).unwrap();
        println!(
            "Request  hex: {}",
            req_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let response = BincodeResponse {
            ok: true,
            value: 100,
            error: None,
        };
        let resp_bytes =
            bincode::serde::encode_to_vec(&response, bincode::config::standard()).unwrap();
        println!(
            "Response hex: {}",
            resp_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let err_response = BincodeResponse {
            ok: false,
            value: 0,
            error: Some("test error".to_string()),
        };
        let err_bytes =
            bincode::serde::encode_to_vec(&err_response, bincode::config::standard()).unwrap();
        println!(
            "ErrorResp hex: {}",
            err_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );
    }

    #[test]
    fn test_invoke_msgpack_round_trip() {
        let request = serde_json::json!({"command": "addNumbers", "args": {"a": 42, "b": 58}});
        let payload = rmp_serde::to_vec(&request).unwrap();

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_msgpack(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let result: serde_json::Value = rmp_serde::from_slice(result_bytes).unwrap();

        assert_eq!(result["ok"], true);
        assert_eq!(result["result"]["value"], 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_postcard_wire_format() {
        let request = BincodeRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let req_bytes = postcard::to_allocvec(&request).unwrap();
        println!(
            "postcard request hex: {}",
            req_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let response = BincodeResponse {
            ok: true,
            value: 100,
            error: None,
        };
        let resp_bytes = postcard::to_allocvec(&response).unwrap();
        println!(
            "postcard response hex: {}",
            resp_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        let err_resp = BincodeResponse {
            ok: false,
            value: 0,
            error: Some("test error".to_string()),
        };
        let err_bytes = postcard::to_allocvec(&err_resp).unwrap();
        println!(
            "postcard err resp hex: {}",
            err_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        // Field-by-field
        for v in [0i64, 42, 58, 100, 127, 128, 256] {
            let b = postcard::to_allocvec(&v).unwrap();
            println!(
                "postcard i64({:>4}) → {} bytes: {}",
                v,
                b.len(),
                b.iter()
                    .map(|x| format!("{:02x}", x))
                    .collect::<Vec<_>>()
                    .join(" ")
            );
        }
        let opt_none: Option<String> = None;
        let b = postcard::to_allocvec(&opt_none).unwrap();
        println!(
            "postcard Opt None → {}",
            b.iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );

        // Round-trip
        let decoded: BincodeRequest = postcard::from_bytes(&req_bytes).unwrap();
        assert_eq!(decoded.command, "addNumbers");
        assert_eq!(decoded.a, 42);
        assert_eq!(decoded.b, 58);
    }

    #[test]
    fn test_rkyv_wire_format() {
        let request = RkyvRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let req_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&request).unwrap();
        println!(
            "rkyv request hex: {}",
            req_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );
        println!("rkyv request len: {}", req_bytes.len());

        let response = RkyvResponse {
            ok: true,
            value: 100,
            error: None,
        };
        let resp_bytes = rkyv::to_bytes::<rkyv::rancor::Error>(&response).unwrap();
        println!(
            "rkyv response hex: {}",
            resp_bytes
                .iter()
                .map(|x| format!("{:02x}", x))
                .collect::<Vec<_>>()
                .join(" ")
        );
        println!("rkyv response len: {}", resp_bytes.len());

        // Zero-copy access
        let archived =
            rkyv::access::<ArchivedRkyvRequest, rkyv::rancor::Error>(&req_bytes).unwrap();
        assert_eq!(archived.command.as_str(), "addNumbers");
        assert_eq!(i64::from(archived.a), 42);
        assert_eq!(i64::from(archived.b), 58);
    }

    #[test]
    fn test_invoke_postcard_round_trip() {
        let request = BincodeRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let payload = postcard::to_allocvec(&request).unwrap();

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_postcard(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let result: BincodeResponse = postcard::from_bytes(result_bytes).unwrap();

        assert_eq!(result.ok, true);
        assert_eq!(result.value, 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_invoke_rkyv_round_trip() {
        let request = RkyvRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let payload = rkyv::to_bytes::<rkyv::rancor::Error>(&request).unwrap();

        let mut out_len: usize = 0;
        let result_ptr =
            unsafe { rustra_calculator_invoke_rkyv(payload.as_ptr(), payload.len(), &mut out_len) };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let archived =
            rkyv::access::<ArchivedRkyvResponse, rkyv::rancor::Error>(result_bytes).unwrap();
        assert_eq!(archived.ok, true);
        assert_eq!(i64::from(archived.value), 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_invoke_hybrid_round_trip() {
        let request = BincodeRequest {
            command: "addNumbers".to_string(),
            a: 42,
            b: 58,
        };
        let payload = postcard::to_allocvec(&request).unwrap();

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_hybrid(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        let archived =
            rkyv::access::<ArchivedRkyvResponse, rkyv::rancor::Error>(result_bytes).unwrap();
        assert_eq!(archived.ok, true);
        assert_eq!(i64::from(archived.value), 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_generic_dispatch() {
        // Build request using postcard wire format:
        // [command_id: u16 @0][postcard(AddNumbersInput)]
        let input = AddNumbersInput { a: 42, b: 58 };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&1u16.to_le_bytes()); // command_id = 1 (addNumbers)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };

        // Response: [ok: u8 @0][pad 7B][postcard(AddNumbersOutput)]
        assert_eq!(result_bytes[0], 1); // ok = true
        let output: AddNumbersOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();
        assert_eq!(output.value, 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_tier2_string_input() {
        // greet (command_id = 5): input has one String field "name"
        // Wire: [cmd_id: u16 @0][postcard(GreetInput)]
        let input = GreetInput {
            name: "World".into(),
        };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&5u16.to_le_bytes()); // command_id = 5 (greet)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Response: [ok @0][pad 7B][postcard(GreetOutput)]
        let output: GreetOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();
        assert_eq!(output.message, "Hello, World!");

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_tier2_vec_input() {
        // sum_list (command_id = 6): input has one Vec<i64> field "numbers"
        // Wire: [cmd_id: u16 @0][postcard(SumListInput)]
        let input = SumListInput {
            numbers: vec![10, 20, 30, 40],
        };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&6u16.to_le_bytes()); // command_id = 6 (sumList)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Response: [ok @0][pad 7B][postcard(SumListOutput)]
        let output: SumListOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();
        assert_eq!(output.count, 4);
        assert_eq!(output.total, 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_tier2_string_output() {
        // to_upper (command_id = 7): input has String field "s", output has String field "result"
        // Wire: [cmd_id: u16 @0][postcard(ToUpperInput)]
        let input = ToUpperInput { s: "hello".into() };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&7u16.to_le_bytes()); // command_id = 7 (toUpper)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Response: [ok @0][pad 7B][postcard(ToUpperOutput)]
        let output: ToUpperOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();
        assert_eq!(output.result, "HELLO");

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_tier3_json_fallback() {
        // process_item (command_id = 9): now uses postcard (no more JSON fallback)
        // Wire: [cmd_id: u16 @0 LE][postcard(ProcessItemInput)]
        let input = ProcessItemInput {
            item: Item {
                active: true,
                name: "widget".into(),
                value: 50,
            },
        };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&9u16.to_le_bytes()); // command_id = 9 (processItem)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Response: [ok=1 @0][pad 7B][postcard(ProcessItemOutput)]
        let output: ProcessItemOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();

        // process_item with value=50 → doubled=false (value not > 100)
        // active = input.item.active && doubled = true && false = false
        assert_eq!(output.item.name, "processed_widget");
        assert_eq!(output.item.value, 100);
        assert_eq!(output.item.active, false);
        assert_eq!(output.doubled, false);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_tier3_create_item() {
        // create_item (command_id = 8): now uses postcard (no more JSON fallback)
        // Wire: [cmd_id: u16 @0 LE][postcard(CreateItemInput)]
        let input = CreateItemInput {
            name: "gadget".into(),
            value: 42,
        };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&8u16.to_le_bytes()); // command_id = 8 (createItem)
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Response: [ok=1 @0][pad 7B][postcard(CreateItemOutput)]
        let output: CreateItemOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();

        assert_eq!(output.item.name, "gadget");
        assert_eq!(output.item.value, 42);
        assert_eq!(output.item.active, true);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_postcard_binary_handler() {
        // Test the fast postcard binary handler path
        // Build request: [cmd_id: u16 LE][postcard(AddNumbersInput)]
        let input = AddNumbersInput { a: 42, b: 58 };
        let input_bytes = postcard::to_allocvec(&input).unwrap();
        let mut payload = vec![0u8; 2 + input_bytes.len()];
        payload[0..2].copy_from_slice(&1u16.to_le_bytes()); // command_id = 1
        payload[2..2 + input_bytes.len()].copy_from_slice(&input_bytes);

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        assert!(out_len > 0);

        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 1); // ok = true

        // Decode postcard response: [ok @0][pad 7B][postcard(AddNumbersOutput) @8...]
        let output: AddNumbersOutput = postcard::from_bytes(&result_bytes[8..]).unwrap();
        assert_eq!(output.value, 100);

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }

    #[test]
    fn test_rkyv_v2_postcard_all_tiers() {
        // Test all 9 commands through the postcard binary handler

        // Tier 1: addNumbers (cmd 1)
        {
            let input = AddNumbersInput { a: 10, b: 20 };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&1u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: AddNumbersOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.value, 30);
            unsafe { rustra_calculator_free_buffer(rp, ol) };
        }

        // Tier 1: multiply (cmd 2)
        {
            let input = MultiplyInput { a: 1.5, b: 2.0 };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&2u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: MultiplyOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert!((out.value - 3.0).abs() < 0.01);
            unsafe { rustra_calculator_free_buffer(rp, ol) };
        }

        // Tier 1: isEven (cmd 3)
        {
            let input = IsEvenInput { n: 42 };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&3u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: IsEvenOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.result, true);
            unsafe { rustra_calculator_free_buffer(rp, ol) };
        }

        // Tier 2: greet (cmd 5)
        {
            let input = GreetInput {
                name: "Rustra".into(),
            };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&5u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: GreetOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.message, "Hello, Rustra!");
            unsafe { rustra_calculator_free_buffer(rp, ol) };
        }

        // Tier 2: sumList (cmd 6)
        {
            let input = SumListInput {
                numbers: vec![1, 2, 3, 4, 5],
            };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&6u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: SumListOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.total, 15);
            assert_eq!(out.count, 5);
            unsafe { rustra_calculator_free_buffer(rp, ol) };
        }

        // Tier 3: createItem (cmd 8) — postcard handles nested structs!
        {
            let input = CreateItemInput {
                name: "Widget".into(),
                value: 42,
            };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&8u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: CreateItemOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.item.name, "Widget");
            assert_eq!(out.item.value, 42);
            assert_eq!(out.item.active, true);
            unsafe { rustra_calculator_free_buffer(rp, ol) };
        }

        // Tier 3: processItem (cmd 9)
        {
            let input = ProcessItemInput {
                item: Item {
                    active: true,
                    name: "Gadget".into(),
                    value: 200,
                },
            };
            let ib = postcard::to_allocvec(&input).unwrap();
            let mut p = vec![0u8; 2 + ib.len()];
            p[0..2].copy_from_slice(&9u16.to_le_bytes());
            p[2..].copy_from_slice(&ib);
            let mut ol: usize = 0;
            let rp = unsafe { rustra_calculator_invoke_rkyv_v2(p.as_ptr(), p.len(), &mut ol) };
            let rb = unsafe { std::slice::from_raw_parts(rp, ol) };
            assert_eq!(rb[0], 1);
            let out: ProcessItemOutput = postcard::from_bytes(&rb[8..]).unwrap();
            assert_eq!(out.item.value, 400);
            assert_eq!(out.doubled, true);
            unsafe { rustra_calculator_free_buffer(rp, ol) };
        }
    }

    #[test]
    fn test_rkyv_v2_error_response_encoding() {
        // Send a payload with an unknown command_id to trigger an error
        let mut payload = vec![0u8; 16];
        payload[0..2].copy_from_slice(&999u16.to_le_bytes()); // unknown command_id
        payload[8..16].copy_from_slice(&0i64.to_le_bytes());

        let mut out_len: usize = 0;
        let result_ptr = unsafe {
            rustra_calculator_invoke_rkyv_v2(payload.as_ptr(), payload.len(), &mut out_len)
        };

        assert!(!result_ptr.is_null());
        let result_bytes = unsafe { std::slice::from_raw_parts(result_ptr, out_len) };
        assert_eq!(result_bytes[0], 0); // ok = false

        // Verify error message is present
        let error_len = u16::from_le_bytes(result_bytes[8..10].try_into().unwrap()) as usize;
        assert!(error_len > 0);
        let error_msg = std::str::from_utf8(&result_bytes[10..10 + error_len]).unwrap();
        assert!(!error_msg.is_empty());

        unsafe { rustra_calculator_free_buffer(result_ptr, out_len) };
    }
}
