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
    ///
    /// No-op if a package is already registered (idempotent).
    pub fn register_ffi_with_default(&self, format: FfiFormat) {
        let _ = PACKAGE.set(self.clone());
        let _ = DEFAULT_FORMAT.set(format);
    }
}

pub fn get_package() -> Option<&'static Package> {
    PACKAGE.get()
}

// -- Wire types ----------------------------------------------------------

/// JSON wire envelope: `{ command, args }` where args is a JSON Value.
#[derive(Serialize, Deserialize)]
struct FfiEnvelope {
    command: String,
    args: serde_json::Value,
}

/// JSON wire response.
#[derive(Serialize, Deserialize)]
struct FfiResponse {
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

/// Postcard wire envelope: args embedded as JSON string for compatibility.
/// (serde_json::Value doesn't round-trip through postcard correctly.)
#[derive(Serialize, Deserialize)]
struct FfiPostcardEnvelope {
    command: String,
    args_json: String,
}

/// Postcard wire response: result embedded as JSON string.
#[derive(Serialize, Deserialize)]
struct FfiPostcardResponse {
    ok: bool,
    result_json: Option<String>,
    error: Option<String>,
}

// -- Buffer helpers ------------------------------------------------------

const MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

fn alloc_response(data: Vec<u8>, out_len: *mut usize) -> *mut u8 {
    let len = data.len();
    unsafe { *out_len = len };
    let boxed: Box<[u8]> = data.into_boxed_slice();
    let ptr = Box::into_raw(boxed) as *mut u8;
    #[cfg(debug_assertions)]
    free_guard::record(ptr, len);
    ptr
}

/// Debug-only allocation tracker for `rustra_ffi_free` misuse detection (F2).
///
/// `alloc_response` records every handed-out `(ptr, len)`; `rustra_ffi_free`
/// classifies a free request against this set before reconstructing the
/// `Box<[u8]>`. This surfaces two UB modes early, in debug/test builds only:
///
/// - **wrong-len free** — `ptr` is live but the caller's `len` mismatches the
///   allocation (reconstructs a `Box` with the wrong layout).
/// - **double-free / foreign pointer** — `ptr` is not live at all.
///
/// In release builds the tracker and its checks compile out entirely (no mutex,
/// no `HashSet`) — across an FFI boundary we cannot *soundly prevent* a caller
/// from misusing `unsafe`; we can only catch it during development. The tracker
/// is best-effort diagnostics, never a release guarantee.
///
/// The classifier returns a [`Verdict`] rather than panicking: a panic cannot
/// unwind through the `extern "C"` nounwind ABI of `rustra_ffi_free`, so the
/// extern entry point itself performs the loud failure (`abort`) on misuse.
#[cfg(debug_assertions)]
mod free_guard {
    use std::collections::HashSet;
    use std::sync::{Mutex, OnceLock};

    /// Classification of a `rustra_ffi_free` request against the live set.
    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum Verdict {
        /// Exact `(ptr, len)` match — sound. Entry removed from the live set.
        Sound,
        /// `ptr` is live but under a different length (wrong-len free → UB).
        WrongLen,
        /// `ptr` is not live at all (double-free or foreign pointer → UB).
        NotLive,
    }

    fn live() -> &'static Mutex<HashSet<(usize, usize)>> {
        static LIVE: OnceLock<Mutex<HashSet<(usize, usize)>>> = OnceLock::new();
        LIVE.get_or_init(|| Mutex::new(HashSet::new()))
    }

    /// Record a freshly handed-out allocation.
    pub(super) fn record(ptr: *mut u8, len: usize) {
        let mut set = live().lock().expect("free_guard mutex poisoned");
        set.insert((ptr as usize, len));
    }

    /// Classify a free request; on [`Verdict::Sound`] the entry is removed.
    ///
    /// Pure classification — never panics, so it is safe to call from inside the
    /// `extern "C"` boundary (which cannot unwind). The caller decides how to
    /// react to a misuse verdict.
    pub(super) fn check(ptr: *mut u8, len: usize) -> Verdict {
        let key = (ptr as usize, len);
        let mut set = live().lock().expect("free_guard mutex poisoned");
        if set.remove(&key) {
            Verdict::Sound
        } else if set.iter().any(|(p, _)| *p == ptr as usize) {
            Verdict::WrongLen
        } else {
            Verdict::NotLive
        }
    }

    #[cfg(test)]
    mod tests {
        //! Verdict logic is exercised here (no extern boundary, no abort).
        //! Each test uses a unique synthetic pointer value so the shared global
        //! live set never collides across parallel tests.
        use super::{check, record, Verdict};

        // 고유 synthetic 포인터 — dereference 되지 않고 key 로만 사용.
        const fn p(n: usize) -> *mut u8 {
            (0xdead_beef_0000 + n) as *mut u8
        }

        #[test]
        fn exact_match_is_sound_and_removes_entry() {
            record(p(0x10), 16);
            assert_eq!(check(p(0x10), 16), Verdict::Sound);
            // 이미 제거됨 → 같은 요청은 이제 NotLive.
            assert_eq!(check(p(0x10), 16), Verdict::NotLive);
        }

        #[test]
        fn same_ptr_different_len_is_wrong_len() {
            record(p(0x20), 32);
            assert_eq!(
                check(p(0x20), 33),
                Verdict::WrongLen,
                "ptr live under len=32 must classify len=33 as WrongLen"
            );
            // 정리: 올바른 len 으로 Sound 제거.
            assert_eq!(check(p(0x20), 32), Verdict::Sound);
        }

        #[test]
        fn second_free_is_not_live() {
            record(p(0x30), 8);
            assert_eq!(check(p(0x30), 8), Verdict::Sound);
            assert_eq!(
                check(p(0x30), 8),
                Verdict::NotLive,
                "double-free must classify as NotLive"
            );
        }

        #[test]
        fn unknown_ptr_is_not_live() {
            assert_eq!(
                check(p(0x99), 64),
                Verdict::NotLive,
                "foreign pointer never recorded must be NotLive"
            );
        }
    }
}

fn err_response(msg: &str, out_len: *mut usize, serialize: fn(&FfiResponse) -> Vec<u8>) -> *mut u8 {
    let resp = FfiResponse {
        ok: false,
        result: None,
        error: Some(msg.to_string()),
    };
    alloc_response(serialize(&resp), out_len)
}

/// 패닉 페이로드에서 사람이 읽을 수 있는 메시지를 추출한다.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
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
            error: Some(format!("internal: panic — {}", panic_message(&*payload))),
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
        Some(FfiFormat::Postcard) => unsafe {
            rustra_ffi_invoke_postcard(payload, payload_len, out_len)
        },
        Some(FfiFormat::Json) | None => unsafe {
            rustra_ffi_invoke_json(payload, payload_len, out_len)
        },
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

    let command = envelope.command;
    let args = envelope.args;
    with_panic_guard(out_len, json_serialize, || dispatch_json(&command, args))
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
    if payload_len > MAX_PAYLOAD_BYTES {
        return err_response(
            "payload exceeds size limit",
            out_len,
            postcard_serialize_response,
        );
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

/// Free a buffer previously returned by one of the `rustra_ffi_invoke_*` functions.
///
/// # Safety
///
/// - `ptr`/`len` must be the **exact** pointer and length returned by a
///   `rustra_ffi_invoke_*` call (or `ptr` may be null). Passing a `len` that
///   mismatches the original allocation reconstructs a `Box<[u8]>` with the
///   wrong layout — undefined behavior.
/// - Must not be called more than once for the same pointer (double-free is UB).
/// - In debug builds, both misuse modes are checked against a live-allocation
///   set and, on detection, the process **aborts** with a diagnostic on stderr
///   (continuing past a confirmed UB misuse is unsound; a panic cannot unwind
///   through this `extern "C"` boundary). Release builds rely on the caller
///   safety contract — the guard compiles out.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() && len > 0 {
        #[cfg(debug_assertions)]
        match free_guard::check(ptr, len) {
            free_guard::Verdict::Sound => {}
            verdict => {
                eprintln!(
                    "rustra_ffi_free: F2 misuse ({verdict:?}) for (ptr,len)=({ptr:p},{len}) — \
                     aborting to avoid UB. Call with the exact (ptr,len) returned by a \
                     rustra_ffi_invoke_* function, exactly once."
                );
                std::process::abort();
            }
        }
        unsafe {
            let slice = std::slice::from_raw_parts_mut(ptr, len);
            let _ = Box::from_raw(slice as *mut [u8]);
        }
    }
}

/// 현재 등록된 패키지의 라이브 스키마를 JSON 바이트로 반환한다 (정적 + 동적 명령).
/// 반환 버퍼는 `rustra_ffi_free` 로 해제. 읽기 전용 — debug/release 모두 사용 가능.
///
/// # Safety
///
/// `out_len` must be a valid, non-null write pointer (a null `out_len` returns a
/// null pointer rather than dereferencing). Caller must free the returned buffer
/// with `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_get_schema(out_len: *mut usize) -> *mut u8 {
    if out_len.is_null() {
        return std::ptr::null_mut();
    }
    match get_package() {
        Some(pkg) => {
            let json = serde_json::to_vec(&pkg.live_schema()).unwrap_or_else(|_| b"{}".to_vec());
            alloc_response(json, out_len)
        }
        None => alloc_response(b"{}".to_vec(), out_len),
    }
}

/// 현재 등록된 패키지의 **계약 해시** (SHA-256 hex) 를 UTF-8 바이트로 반환한다.
///
/// `live_schema()` 를 `serde_json::to_string_pretty` 로 직렬화한 뒤 해시한다 — 이는
/// 빌드 시점 `generate_typescript()` → `contract.ts` 의 `GENERATED_CONTRACT_HASH` 와
/// 동일한 입력/알고리즘이므로 양쪽 값이 일치해야 한다. 호스트(TS 엔진)는 이 값을
/// `contractHash` 옵션(F5) 과 비교해 스키마 드리프트를 런타임에 검증한다.
/// 패키지가 미등록이면 빈 문자열을 반환한다.
///
/// 반환 버퍼는 `rustra_ffi_free` 로 해제.
///
/// # Safety
///
/// `out_len` must be a valid, non-null write pointer. Caller must free the
/// returned buffer with `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_contract_hash(out_len: *mut usize) -> *mut u8 {
    if out_len.is_null() {
        return std::ptr::null_mut();
    }
    let hex = match get_package() {
        Some(pkg) => {
            let json = serde_json::to_string_pretty(&pkg.live_schema()).unwrap_or_default();
            crate::codegen::contract_hash(json)
        }
        None => String::new(),
    };
    alloc_response(hex.into_bytes(), out_len)
}

// -- Tests ---------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Package;

    fn test_package() -> Package {
        Package::builder("test.ffi")
            .command("addNumbers", |args: serde_json::Value| {
                let a = args["a"].as_i64().unwrap_or(0);
                let b = args["b"].as_i64().unwrap_or(0);
                Ok::<_, crate::RustraError>(serde_json::json!(a + b))
            })
            .build()
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

        // 1. Direct postcard call
        let envelope = FfiPostcardEnvelope {
            command: "addNumbers".into(),
            args_json: serde_json::to_string(&serde_json::json!({"a": 20, "b": 22})).unwrap(),
        };
        let payload = postcard::to_allocvec(&envelope).unwrap();
        let mut out_len: usize = 0;

        let ptr =
            unsafe { rustra_ffi_invoke_postcard(payload.as_ptr(), payload.len(), &mut out_len) };

        assert!(!ptr.is_null());
        assert!(out_len > 0);

        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
        let resp: FfiPostcardResponse = postcard::from_bytes(bytes).unwrap();
        assert!(resp.ok);
        let result: serde_json::Value = serde_json::from_str(&resp.result_json.unwrap()).unwrap();
        assert_eq!(result, 42);

        unsafe { rustra_ffi_free(ptr, out_len) };

        // 2. Default dispatches to postcard
        let envelope2 = FfiPostcardEnvelope {
            command: "addNumbers".into(),
            args_json: serde_json::to_string(&serde_json::json!({"a": 10, "b": 15})).unwrap(),
        };
        let payload2 = postcard::to_allocvec(&envelope2).unwrap();
        let mut out_len2: usize = 0;

        let ptr2 = unsafe { rustra_ffi_invoke(payload2.as_ptr(), payload2.len(), &mut out_len2) };
        assert!(!ptr2.is_null());

        let bytes2 = unsafe { std::slice::from_raw_parts(ptr2, out_len2) };
        let resp2: FfiPostcardResponse = postcard::from_bytes(bytes2).unwrap();
        assert!(resp2.ok);
        let result2: serde_json::Value = serde_json::from_str(&resp2.result_json.unwrap()).unwrap();
        assert_eq!(result2, 25);

        unsafe { rustra_ffi_free(ptr2, out_len2) };
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

    #[test]
    fn ffi_get_schema_returns_live_schema() {
        let pkg = test_package();
        pkg.register_ffi();

        let mut out_len: usize = 0;
        let ptr = unsafe { rustra_ffi_get_schema(&mut out_len) };
        assert!(!ptr.is_null());
        assert!(out_len > 0);

        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) };
        let v: serde_json::Value = serde_json::from_slice(bytes).unwrap();
        assert_eq!(v["packageId"], "test.ffi");
        assert!(v["commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "addNumbers"));

        unsafe { rustra_ffi_free(ptr, out_len) };
    }
}
