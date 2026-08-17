//! Generic FFI entry points for rustra packages.
//!
//! Instead of writing per-example `extern "C"` functions, consumers call
//! `package.register_ffi()` and the framework exposes generic FFI symbols:
//!
//! - `rustra_ffi_invoke`          — default path (configurable)
//! - `rustra_ffi_invoke_json`     — JSON-over-bytes path
//! - `rustra_ffi_invoke_postcard` — postcard binary path
//! - `rustra_ffi_free`            — free returned buffers
//! - `rustra_ffi_event_sink_register`   — C 콜백 이벤트 싱크 설치 (push)
//! - `rustra_ffi_event_sink_unregister` — 싱크 해제 (폴링 복귀)

use crate::Package;
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_void};
use std::sync::{Mutex, OnceLock};

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
        // rustra_ffi_event_sink_register 가 패키지 등록보다 먼저 호출된 경우의
        // 지연 설치 — C 싱크가 이미 등록되어 있으면 지금 Rust 싱크로 연결한다.
        self.install_pending_ffi_event_sink();
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
const FFI_MAGIC: u32 = 0x5255_5354; // "RUST" in ASCII
const FFI_HEADER_SIZE: usize = 8;

fn alloc_response(data: Vec<u8>, out_len: *mut usize) -> *mut u8 {
    let payload_len = data.len();
    unsafe { *out_len = payload_len };

    let total_len = FFI_HEADER_SIZE + payload_len;
    let mut buf = Vec::with_capacity(total_len);
    buf.extend_from_slice(&FFI_MAGIC.to_le_bytes());
    buf.extend_from_slice(&(payload_len as u32).to_le_bytes());
    buf.extend_from_slice(&data);

    let boxed: Box<[u8]> = buf.into_boxed_slice();
    let raw_ptr = Box::into_raw(boxed) as *mut u8;
    let user_ptr = unsafe { raw_ptr.add(FFI_HEADER_SIZE) };

    #[cfg(debug_assertions)]
    free_guard::record(user_ptr, payload_len);

    user_ptr
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
        use super::{Verdict, check, record};

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

/// Async FFI invoke entry point (P0-3 worker thread offload).
///
/// Runs the command dispatch on a background worker thread, then calls `on_complete`
/// with `(user_data, response_ptr, response_len)`. The calling thread returns immediately.
///
/// # Safety
///
/// - `payload` must point to `payload_len` valid bytes (or null if len 0).
/// - `on_complete` must be a thread-safe C callback function pointer.
/// - The caller must free `response_ptr` using `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_async(
    payload: *const u8,
    payload_len: usize,
    user_data: *mut c_void,
    on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
) {
    let user_data_raw = user_data as usize;
    let bytes = if payload.is_null() || payload_len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len).to_vec() }
    };

    std::thread::spawn(move || {
        let mut out_len = 0;
        let resp_ptr = unsafe { rustra_ffi_invoke(bytes.as_ptr(), bytes.len(), &mut out_len) };
        if let Some(cb) = on_complete {
            unsafe {
                cb(user_data_raw as *mut c_void, resp_ptr, out_len);
            }
        }
    });
}

/// Async JSON FFI invoke entry point.
///
/// # Safety
///
/// - `payload` must point to `payload_len` valid bytes (or null if len 0).
/// - `on_complete` must be a thread-safe C callback function pointer.
/// - The caller must free the response pointer in the callback using `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_json_async(
    payload: *const u8,
    payload_len: usize,
    user_data: *mut c_void,
    on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
) {
    let user_data_raw = user_data as usize;
    let bytes = if payload.is_null() || payload_len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len).to_vec() }
    };

    std::thread::spawn(move || {
        let mut out_len = 0;
        let resp_ptr = unsafe { rustra_ffi_invoke_json(bytes.as_ptr(), bytes.len(), &mut out_len) };
        if let Some(cb) = on_complete {
            unsafe {
                cb(user_data_raw as *mut c_void, resp_ptr, out_len);
            }
        }
    });
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
            let header_ptr = ptr.sub(FFI_HEADER_SIZE);
            let magic = u32::from_le_bytes(*(header_ptr as *const [u8; 4]));
            let alloc_len = u32::from_le_bytes(*(header_ptr.add(4) as *const [u8; 4])) as usize;

            if magic != FFI_MAGIC {
                eprintln!(
                    "rustra_ffi_free: invalid magic 0x{magic:08x} at {ptr:p} (double-free or foreign pointer) — rejecting free to prevent UB"
                );
                return;
            }

            // Invalidate magic to prevent double-free
            std::ptr::write_bytes(header_ptr, 0, 4);

            let total_len = FFI_HEADER_SIZE + alloc_len;
            let raw_slice = std::slice::from_raw_parts_mut(header_ptr, total_len);
            let _ = Box::from_raw(raw_slice as *mut [u8]);
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

// -- Event sink (push delivery) ------------------------------------------

/// C 호스트가 `rustra_ffi_event_sink_register` 로 등록하는 콜백 원형.
///
/// `user_data` 는 등록 시 호스트가 넢긴 포인터 그대로, `name`/`payload` 는
/// NUL 종료 UTF-8 C 문자열(호출 기간에만 유효 — 필요하면 복사).
///
/// ABI 는 `extern "C-unwind"` 다 — 콜백이 되감기(unwind)를 일으킬 수 있음을
/// 명시한다. Rust `catch_unwind` 이 콜백 패닉을 가둬 emit 호출자를 보호하는
/// 계약([`events::EventSink`] 의 패닉 격리)과 짝을 이룬다. 순수 C 호스트는
/// 되감기를 일으키지 않으므로 그대로 동작한다.
pub type FfiEventCallback = unsafe extern "C-unwind" fn(
    user_data: *mut c_void,
    name: *const c_char,
    payload: *const c_char,
);

/// 등록된 C 콜백 + 호스트 소유 `user_data`. 전역 [`Mutex`] 하나로 보호한다 —
/// 등록/해제는 부트스트랩·종료 시점에 드물게 일어나므로 락 경합은 무시 가능.
struct FfiEventSink {
    callback: FfiEventCallback,
    #[allow(clippy::trivially_copy_pass_by_ref)]
    user_data: *mut c_void,
}

impl Clone for FfiEventSink {
    fn clone(&self) -> Self {
        Self {
            callback: self.callback,
            user_data: self.user_data,
        }
    }
}

/// `FfiEventSink.user_data` 는 호스트 소유 원시 포인터 — Rust 이동/빌림 규칙
/// 밖이다. 콜백 래퍼에서만 값으로 취급(역참조 없음)하므로 `Send + Sync` 선언이
/// 안전하다.
unsafe impl Send for FfiEventSink {}
unsafe impl Sync for FfiEventSink {}

impl FfiEventSink {
    /// 저장된 콜백을 C ABI 로 호출한다. 문자열은 NUL 종료로 변환해 전달한다.
    ///
    /// 반환 `false` 는 name/payload 에 내부 NUL 이 있어 CString 변환에 실패해
    /// 이벤트가 소실되었다는 뜻이다(호출자가 로그로 처리).
    fn invoke(&self, name: &str, payload: &str) -> bool {
        let Ok(name_c) = std::ffi::CString::new(name) else {
            return false;
        };
        let Ok(payload_c) = std::ffi::CString::new(payload) else {
            return false;
        };
        unsafe { (self.callback)(self.user_data, name_c.as_ptr(), payload_c.as_ptr()) };
        true
    }
}

static FFI_EVENT_SINK: Mutex<Option<FfiEventSink>> = Mutex::new(None);

/// 전역 패키지에 C 콜백 기반 이벤트 싱크를 설치한다.
///
/// 설치 이후 `Package::emit` 은 이벤트 버스 적재 대신 즉시
/// `callback(user_data, name, payload)` 을 호출한다 — 각 인자는 NUL 종료 UTF-8
/// C 문자열 포인터다. `payload` 는 JSON 직렬화된 문자열 그대로다(파싱은 JS
/// 어댑터에서 1회).
///
/// # 스레드 계약
///
/// 콜백은 `emit` 을 호출한 **어느 스레드에서든** 실행될 수 있다. JSI 같은
/// 런타임 스레드 친화성이 필요한 호스트는 콜백 안에서 자체 큐잉 후 자기
/// 런타임 스레드(CallInvoker 등)로 마샬링해야 한다.
///
/// # 패닉 격리
///
/// 패닉은 [`events::EventState::deliver_via_sink`] 의 `catch_unwind` 이 가둔다
/// — 콜백이 패닉하면 stderr 로그 후 해당 이벤트가 소실되고 `emit` 은 정상
/// 복귀한다(싱크는 유지).
///
/// **되감기(unwind) 금지 계약**: C++ 호스트 콜백은 예외를 밖으로 던지면 안
/// 된다. Rust 패닉은 `catch_unwind` 으로 격리되지만, Rust 프레임을 통과하는
/// **외국(foreign) 예외**는 Rust 가 잡을 수 없어 정의된 즉시 abort 다
/// (`"C-unwind"` ABI 하에서 UB 대신 abort 로 보장된 것). C++ 콜백은
/// `noexcept` 로 표시하거나 최상위 `catch (...)` 로 삼키라.
///
/// # Safety
///
/// `callback` 은 유효한 함수 포인터여야 한다. `user_data` 는 호스트가 소유하며
/// [`rustra_ffi_event_sink_unregister`] 전까지(또는 교체 등록 직전까지) 유효해야
/// 한다. 이미 등록된 싱크가 있으면 조용히 교체한다(구 콜백은 더 이상 호출되지
/// 않는다 — 구 `user_data` 해제는 호스트 책임).
///
/// **진행 중 emit 창**: 해제/교체가 반환된 직후에도 이미 진행 중이던 `emit`
/// 이 구 콜백과 구 `user_data` 를 1회 더 호출할 수 있다(delivery 경로가 싱크
/// `Arc` 를 복제한 뒤 호출하기 때문). `user_data` 를 다른 스레드에서 즉시
/// 해제하면 안전하지 않다 — 해제는 해당 호출 여부를 동기화한 뒤에 하라.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_event_sink_register(
    callback: FfiEventCallback,
    user_data: *mut c_void,
) {
    // catch_unwind: 전역 락이 이미 포이즈닝된 경우에도 등록 경로가 UB 를
    // 만들지 않게 한다(패닉은 stderr 로그만 남긴다).
    let _ = std::panic::catch_unwind(|| {
        let new_sink = FfiEventSink {
            callback,
            user_data,
        };
        let mut guard = match FFI_EVENT_SINK.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = Some(new_sink.clone());
        drop(guard);

        // 전역 패키지가 이미 등록되어 있으면 Rust 싱크를 설치한다. 미등록이면
        // 나중에 register_ffi() 가 호출될 때 install_pending_ffi_event_sink 가
        // 설치를 이어간다(지연 설치).
        if let Some(pkg) = PACKAGE.get() {
            pkg.set_event_sink(Some(rust_event_sink(new_sink)));
        }
    });
}

/// 설치된 C 콜백 싱크를 제거하고 폴링(이벤트 버스) 경로로 되돌린다.
///
/// 제거 후 `emit` 은 다시 버스에 적재된다 — `take_pending_events` 폴링 호스트와
/// 상호 운용된다. 미등록 상태에서 호출해도 안전하다(no-op).
///
/// # Safety
///
/// 이 함수 자체는 안전하게 호출할 수 있다(unsafe 는 `extern "C"` ABI 선언의
/// 산물이다). 등록된 콜백의 `user_data` 소유권은 여전히 호스트에게 있다 —
/// 해제 시점은 호스트가 결정한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_event_sink_unregister() {
    let _ = std::panic::catch_unwind(|| {
        let mut guard = match FFI_EVENT_SINK.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        *guard = None;
        if let Some(pkg) = PACKAGE.get() {
            pkg.set_event_sink(None);
        }
    });
}

/// C 콜백을 [`crate::events::EventSink`] 로 감싼 Rust 클로저를 만든다.
///
/// 콜백 스냅샷을 클로저에 캡처한다 — 등록 시점의 (callback, user_data) 쌍이
/// 그대로 호출되고, 재등록/해제는 `set_event_sink` 교체로 반영된다. emit 시점에
/// 전역 레지스트리를 다시 읽지 않으므로 재등록 직후 진행 중이던 emit 이 구
/// 콜백을 호출하는 창이 최소화된다(정확히 한 번 전달은 유지).
fn rust_event_sink(sink: FfiEventSink) -> crate::events::EventSink {
    std::sync::Arc::new(move |name: &str, payload: &str| {
        // name/payload 는 rustra 가 생성한 UTF-8 이므로 내부 NUL 변환 실패는
        // 사실상 불가 — 실패해도 이벤트 소실 로그만 남기고 패닉하지 않는다.
        if !sink.invoke(name, payload) {
            eprintln!("rustra: event name/payload contains interior NUL — event dropped");
        }
    })
}

impl Package {
    /// (내부용) FFI C 콜백 싱크가 등록되어 있으면 이 패키지에 설치한다.
    ///
    /// `register_ffi` 보다 `rustra_ffi_event_sink_register` 가 먼저 호출된 경우
    /// (패키지 미등록) 지연 설치를 위해 사용된다.
    fn install_pending_ffi_event_sink(&self) {
        let pending = match FFI_EVENT_SINK.lock() {
            Ok(g) => g.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        if let Some(sink) = pending {
            self.set_event_sink(Some(rust_event_sink(sink)));
        }
    }
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
        assert!(
            v["commands"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["name"] == "addNumbers")
        );

        unsafe { rustra_ffi_free(ptr, out_len) };
    }

    // ── rustra_ffi_event_sink_register / unregister ─────────────
    //
    // 전역 PACKAGE / FFI_EVENT_SINK 을 공유하므로 병렬 테스트 간 간섭이 생긴다
    // (PACKAGE.set 은 첫 등록만 유효 — 이후 테스트의 패키지는 전역에 반영되지
    // 않는다). 따라서 상태 전이 전체(등록 → emit 수신 → 해제 → 폴링 복귀)를
    // 하나의 순차 테스트로 완결하고, 전역 락으로 다른 sink 테스트와 상호배제한다.

    /// 전역 PACKAGE 가 이미 등록되어 있으면 그것을, 아니면 지금 등록한다.
    /// (register_ffi 는 idempotent — 첫 호출이 이긴다.)
    fn ensure_global_package() -> Package {
        let pkg = test_package();
        pkg.register_ffi();
        PACKAGE.get().expect("package must be registered").clone()
    }

    /// C 콜백이 (name, payload) 를 그대로 수신하는지 검증한다.
    unsafe extern "C-unwind" fn record_event_cb(
        user_data: *mut c_void,
        name: *const c_char,
        payload: *const c_char,
    ) {
        let seen = unsafe { &*(user_data as *const Mutex<Vec<(String, String)>>) };
        let name = unsafe { std::ffi::CStr::from_ptr(name) }
            .to_string_lossy()
            .into_owned();
        let payload = unsafe { std::ffi::CStr::from_ptr(payload) }
            .to_string_lossy()
            .into_owned();
        seen.lock().unwrap().push((name, payload));
    }

    /// sink 테스트 간 상호배제 락 — 등록/해제가 전역 상태를 공유하므로.
    static SINK_TEST_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn ffi_event_sink_register_receives_emit_and_bypasses_bus() {
        let _guard = SINK_TEST_MUTEX.lock().unwrap();
        let pkg = ensure_global_package();

        let seen: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
        unsafe {
            rustra_ffi_event_sink_register(record_event_cb, &seen as *const _ as *mut c_void)
        };

        pkg.emit("progress.tick", serde_json::json!({ "value": 42 }));

        let events = seen.lock().unwrap().clone();
        assert_eq!(events.len(), 1, "C callback must receive the emit");
        assert_eq!(events[0].0, "progress.tick");
        let payload: serde_json::Value = serde_json::from_str(&events[0].1).unwrap();
        assert_eq!(payload["value"], 42);
        assert!(
            pkg.event_bus().take_pending_events().is_empty(),
            "sink installed → bus must stay empty"
        );

        // 정리 — 이후 테스트가 폴링 경로에서 시작하도록.
        unsafe { rustra_ffi_event_sink_unregister() };
    }

    #[test]
    fn ffi_event_sink_unregister_restores_polling() {
        let _guard = SINK_TEST_MUTEX.lock().unwrap();
        let pkg = ensure_global_package();

        let seen: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
        unsafe {
            rustra_ffi_event_sink_register(record_event_cb, &seen as *const _ as *mut c_void)
        };
        pkg.emit("a", serde_json::json!({ "n": 1 }));
        unsafe { rustra_ffi_event_sink_unregister() };

        pkg.emit("b", serde_json::json!({ "n": 2 }));

        assert_eq!(
            seen.lock().unwrap().len(),
            1,
            "only pre-unregister emit hits the callback"
        );
        let polled = pkg.event_bus().take_pending_events();
        assert_eq!(polled.len(), 1, "post-unregister emit must go to the bus");
        assert_eq!(polled[0].name, "b");
    }

    #[test]
    fn ffi_event_sink_panicking_callback_does_not_break_emit() {
        let _guard = SINK_TEST_MUTEX.lock().unwrap();
        let pkg = ensure_global_package();

        unsafe extern "C-unwind" fn panic_cb(
            _user_data: *mut c_void,
            _name: *const c_char,
            _payload: *const c_char,
        ) {
            panic!("host callback exploded");
        }
        unsafe { rustra_ffi_event_sink_register(panic_cb, std::ptr::null_mut()) };

        // 패닉이 emit 호출자로 전파되지 않아야 한다 (deliver_via_sink 가 격리).
        pkg.emit("boom", serde_json::json!({ "n": 1 }));
        pkg.emit("boom", serde_json::json!({ "n": 2 }));

        unsafe { rustra_ffi_event_sink_unregister() };
    }

    #[test]
    fn ffi_event_sink_register_before_package_defers_install() {
        let _guard = SINK_TEST_MUTEX.lock().unwrap();
        // 등록 순서가 반대인 경우: 싱크 먼저 → 패키지 등록 나중.
        // register_ffi_with_default 이 지연 설치를 이어받아야 한다.
        // (전역 PACKAGE 는 다른 테스트가 이미 등록했을 수 있다 — 어느 쪽이든
        //  지연 설치 경로가 동일하게 검증된다: FFI_EVENT_SINK 상태만 확인.)
        unsafe { rustra_ffi_event_sink_unregister() }; // 깨끗한 상태에서 시작
        let seen: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
        unsafe {
            rustra_ffi_event_sink_register(record_event_cb, &seen as *const _ as *mut c_void)
        };

        let pkg = ensure_global_package();

        pkg.emit("late.register", serde_json::json!({ "ok": true }));

        let events = seen.lock().unwrap().clone();
        assert_eq!(
            events.len(),
            1,
            "deferred install must connect the C sink on register_ffi"
        );
        assert_eq!(events[0].0, "late.register");

        unsafe { rustra_ffi_event_sink_unregister() };
        pkg.emit("after", serde_json::json!({ "n": 3 }));
        assert_eq!(pkg.event_bus().take_pending_events().len(), 1);
    }
}
