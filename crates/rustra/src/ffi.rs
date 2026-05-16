//! Generic FFI entry points for rustra packages.
//!
//! Instead of writing per-example `extern "C"` functions, consumers call
//! `package.register_ffi()` and the framework exposes generic FFI symbols:
//!
//! - `rustra_ffi_invoke`          — default path (configurable)
//! - `rustra_ffi_invoke_json`     — JSON-over-bytes path
//! - `rustra_ffi_invoke_postcard` — postcard binary path
//! - `rustra_ffi_free`            — free returned buffers

use crate::Package;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

static PACKAGE: OnceLock<Package> = OnceLock::new();
static DEFAULT_FORMAT: OnceLock<FfiFormat> = OnceLock::new();

/// Supported FFI serialization formats.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FfiFormat {
    Json,
    Postcard,
}

// -- Package extension ---------------------------------------------------

impl Package {
    /// Register this package as the global FFI target with the default format (Postcard).
    pub fn register_ffi(&self) {
        self.register_ffi_with_default(FfiFormat::Postcard);
    }

    /// Register this package as the global FFI target with an explicit default format.
    ///
    /// `rustra_ffi_invoke` will dispatch to the chosen format.
    /// The per-format functions (`rustra_ffi_invoke_json`, `rustra_ffi_invoke_postcard`)
    /// are always available regardless of the default.
    pub fn register_ffi_with_default(&self, format: FfiFormat) {
        PACKAGE
            .set(self.clone())
            .expect("register_ffi: only one package can be registered");
        DEFAULT_FORMAT
            .set(format)
            .expect("register_ffi: only one default format can be set");
    }
}

fn get_package() -> Option<&'static Package> {
    PACKAGE.get()
}

// -- Wire types ----------------------------------------------------------

#[derive(Serialize, Deserialize)]
struct FfiEnvelope {
    command: String,
    args: serde_json::Value,
}

#[derive(Serialize, Deserialize)]
struct FfiResponse {
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

// -- Buffer helpers ------------------------------------------------------

const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

fn alloc_response(data: Vec<u8>, out_len: *mut usize) -> *mut u8 {
    unsafe { *out_len = data.len() };
    let boxed: Box<[u8]> = data.into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}

fn err_response(msg: &str, out_len: *mut usize, serialize: fn(&FfiResponse) -> Vec<u8>) -> *mut u8 {
    let resp = FfiResponse {
        ok: false,
        result: None,
        error: Some(msg.to_string()),
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
    serde_json::to_vec(resp).unwrap_or_else(|_| b"{\"ok\":false,\"error\":\"json encode failed\"}".to_vec())
}

fn json_deserialize_envelope(bytes: &[u8]) -> Result<FfiEnvelope, String> {
    serde_json::from_slice(bytes).map_err(|e| format!("json decode failed: {e}"))
}

// -- Postcard serialization helpers --------------------------------------

fn postcard_serialize(resp: &FfiResponse) -> Vec<u8> {
    postcard::to_allocvec(resp).unwrap_or_default()
}

fn postcard_deserialize_envelope(bytes: &[u8]) -> Result<FfiEnvelope, String> {
    postcard::from_bytes(bytes).map_err(|e| format!("postcard decode failed: {e}"))
}

// -- FFI entry points ----------------------------------------------------

/// Default path — dispatches to the configured default format.
///
/// # Safety
///
/// `payload` must point to at least `payload_len` readable bytes.
/// `out_len` must be a valid write pointer.
/// Caller must free the returned buffer with `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }

    match DEFAULT_FORMAT.get() {
        Some(FfiFormat::Postcard) => {
            unsafe { rustra_ffi_invoke_postcard(payload, payload_len, out_len) }
        }
        Some(FfiFormat::Json) | None => {
            unsafe { rustra_ffi_invoke_json(payload, payload_len, out_len) }
        }
    }
}

/// JSON-over-bytes path.
///
/// Request:  JSON `{"command":"...","args":{...}}` as raw bytes.
/// Response: JSON `{"ok":bool,"result":...,"error":"..."}` as raw bytes.
///
/// # Safety
///
/// Same as [`rustra_ffi_invoke`].
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_json(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    if payload_len > MAX_PAYLOAD_BYTES {
        return err_response("payload exceeds size limit", out_len, json_serialize);
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let envelope = match json_deserialize_envelope(bytes) {
        Ok(env) => env,
        Err(e) => return err_response(&e, out_len, json_serialize),
    };

    let resp = dispatch_json(&envelope.command, envelope.args);
    alloc_response(json_serialize(&resp), out_len)
}

/// Postcard binary path.
///
/// Request:  postcard-encoded `FfiEnvelope { command, args }`.
/// Response: postcard-encoded `FfiResponse { ok, result, error }`.
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
    if payload_len > MAX_PAYLOAD_BYTES {
        return err_response("payload exceeds size limit", out_len, postcard_serialize);
    }

    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    let envelope = match postcard_deserialize_envelope(bytes) {
        Ok(env) => env,
        Err(e) => return err_response(&e, out_len, postcard_serialize),
    };

    let resp = dispatch_json(&envelope.command, envelope.args);
    alloc_response(postcard_serialize(&resp), out_len)
}

/// Free a buffer previously returned by one of the `rustra_ffi_invoke_*` functions.
///
/// # Safety
///
/// `ptr` must have been returned by a `rustra_ffi_invoke_*` call,
/// or be null. Must not be called more than once for the same pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        unsafe {
            let slice = std::slice::from_raw_parts_mut(ptr, len);
            let _ = Box::from_raw(slice as *mut [u8]);
        }
    }
}

// -- Tests ---------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Package;

    fn test_package() -> Package {
        crate::build!("test.ffi", crate::test_helper::add_numbers).done()
    }

    mod test_helper {
        use crate::prelude::*;

        #[command]
        pub fn add_numbers(a: i64, b: i64) -> i64 {
            a + b
        }
    }

    #[test]
    fn ffi_json_round_trip() {
        let pkg = test_package();
        pkg.register_ffi();

        let request = serde_json::json!({"command": "addNumbers", "args": {"a": 20, "b": 22}});
        let payload = serde_json::to_vec(&request).unwrap();
        let mut out_len: usize = 0;

        let ptr = unsafe { rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len) };

        assert!(!ptr.is_null());
        assert!(out_len > 0);

        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
        let resp: FfiResponse = serde_json::from_slice(bytes).unwrap();
        assert!(resp.ok);
        assert_eq!(resp.result.unwrap(), 42);

        unsafe { rustra_ffi_free(ptr, out_len) };
    }

    #[test]
    fn ffi_postcard_round_trip() {
        let pkg = test_package();
        pkg.register_ffi();

        let envelope = FfiEnvelope {
            command: "addNumbers".into(),
            args: serde_json::json!({"a": 20, "b": 22}),
        };
        let payload = postcard::to_allocvec(&envelope).unwrap();
        let mut out_len: usize = 0;

        let ptr = unsafe { rustra_ffi_invoke_postcard(payload.as_ptr(), payload.len(), &mut out_len) };

        assert!(!ptr.is_null());
        assert!(out_len > 0);

        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
        let resp: FfiResponse = postcard::from_bytes(bytes).unwrap();
        assert!(resp.ok);
        assert_eq!(resp.result.unwrap(), 42);

        unsafe { rustra_ffi_free(ptr, out_len) };
    }

    #[test]
    fn ffi_default_dispatches_to_postcard() {
        let pkg = test_package();
        pkg.register_ffi(); // default = postcard

        let envelope = FfiEnvelope {
            command: "addNumbers".into(),
            args: serde_json::json!({"a": 10, "b": 15}),
        };
        let payload = postcard::to_allocvec(&envelope).unwrap();
        let mut out_len: usize = 0;

        let ptr = unsafe { rustra_ffi_invoke(payload.as_ptr(), payload.len(), &mut out_len) };
        assert!(!ptr.is_null());

        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
        let resp: FfiResponse = postcard::from_bytes(bytes).unwrap();
        assert!(resp.ok);
        assert_eq!(resp.result.unwrap(), 25);

        unsafe { rustra_ffi_free(ptr, out_len) };
    }

    #[test]
    fn ffi_default_dispatches_to_json_when_configured() {
        let pkg = test_package();
        pkg.register_ffi_with_default(FfiFormat::Json);

        let request = serde_json::json!({"command": "addNumbers", "args": {"a": 3, "b": 4}});
        let payload = serde_json::to_vec(&request).unwrap();
        let mut out_len: usize = 0;

        let ptr = unsafe { rustra_ffi_invoke(payload.as_ptr(), payload.len(), &mut out_len) };
        assert!(!ptr.is_null());

        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
        let resp: FfiResponse = serde_json::from_slice(bytes).unwrap();
        assert!(resp.ok);
        assert_eq!(resp.result.unwrap(), 7);

        unsafe { rustra_ffi_free(ptr, out_len) };
    }

    #[test]
    fn ffi_null_payload_returns_null() {
        let pkg = test_package();
        pkg.register_ffi();

        let mut out_len: usize = 0;
        let ptr = unsafe { rustra_ffi_invoke(std::ptr::null(), 0, &mut out_len) };
        assert!(ptr.is_null());
    }

    #[test]
    fn ffi_unknown_command_returns_error() {
        let pkg = test_package();
        pkg.register_ffi();

        let request = serde_json::json!({"command": "nonexistent", "args": {}});
        let payload = serde_json::to_vec(&request).unwrap();
        let mut out_len: usize = 0;

        let ptr = unsafe { rustra_ffi_invoke_json(payload.as_ptr(), payload.len(), &mut out_len) };
        assert!(!ptr.is_null());

        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
        let resp: FfiResponse = serde_json::from_slice(bytes).unwrap();
        assert!(!resp.ok);
        assert!(resp.error.unwrap().contains("not found"));

        unsafe { rustra_ffi_free(ptr, out_len) };
    }
}
