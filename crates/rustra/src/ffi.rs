//! Generic FFI entry points for rustra packages.
//!
//! Instead of writing per-example `extern "C"` functions, consumers call
//! `package.register_ffi()` and the framework exposes generic FFI symbols:
//!
//! - `rustra_ffi_invoke`          — default path (configurable)
//! - `rustra_ffi_invoke_json`     — JSON-over-bytes path
//! - `rustra_ffi_invoke_postcard` — postcard binary path
//! - `rustra_ffi_invoke_async`         — 백그라운드 스레드 invoke + invocation_id 발급
//! - `rustra_ffi_invoke_json_async`    — JSON 버전 async invoke + invocation_id 발급
//! - `rustra_ffi_invoke_cancel`        — 진행 중 호출 취소 (협력적)
//! - `rustra_ffi_cancellation_status`  — 호출 취소 상태 조회 (0/1/2)
//! - `rustra_ffi_free`            — free returned buffers
//! - `rustra_ffi_event_sink_register`   — C 콜백 이벤트 싱크 설치 (push)
//! - `rustra_ffi_event_sink_unregister` — 싱크 해제 (폴링 복귀)
//! - `rustra_ffi_set_max_payload`  — (T3) 페이로드 크기 한도 동적 변경
//! - `rustra_ffi_get_max_payload`  — (T3) 현재 페이로드 크기 한도 조회

use crate::Package;
use serde::{Deserialize, Serialize};
use std::ffi::{c_char, c_void};
use std::sync::{Mutex, OnceLock};

struct FfiContext {
    package: Package,
    default_format: FfiFormat,
}

// 패키지와 기본 wire format은 하나의 불변 컨텍스트로 원자적으로 등록한다.
// 별도 OnceLock 두 개는 동시 최초 등록에서 A의 package와 B의 format이 섞일
// 수 있었다.
static FFI_CONTEXT: OnceLock<FfiContext> = OnceLock::new();

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
        let _ = FFI_CONTEXT.set(FfiContext {
            package: self.clone(),
            default_format: format,
        });
        // rustra_ffi_event_sink_register 가 패키지 등록보다 먼저 호출된 경우의
        // 지연 설치 — C 싱크가 이미 등록되어 있으면 지금 Rust 싱크로 연결한다.
        if let Some(context) = FFI_CONTEXT.get() {
            context.package.install_pending_ffi_event_sink();
        }
    }
}

pub fn get_package() -> Option<&'static Package> {
    FFI_CONTEXT.get().map(|context| &context.package)
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

/// (T3) 페이로드 크기 한도의 기본값 — 1 MiB. 런타임 값은
/// [`MAX_PAYLOAD_BYTES`] (atomic) 로, `rustra_ffi_set_max_payload` 로 변경한다.
const DEFAULT_MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

/// (T3) 페이로드 크기 한도 — 부팅 시 고정이 아니라 호스트가 동적으로 조정한다.
/// 크기 게이트는 어림잡기 용도이므로 원자성만 필요하고 순서는 요구되지 않는다.
static MAX_PAYLOAD_BYTES: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(DEFAULT_MAX_PAYLOAD_BYTES);

/// 현재 페이로드 크기 한도 (invoke 경로의 크기 가드가 읽는 단일 지점).
///
/// 공개 판독기(구현 완료) — `Package::invoke_rkyv_v2` 등 FFI 엔트리가 직접
/// 노출하지 않는 경로(rkyv V2 와이어)도 동일한 동적 한도를 읽어 게이트한다.
/// `rustra_ffi_get_max_payload` FFI 심볼과 같은 값을 반환한다.
pub fn max_payload_bytes() -> usize {
    MAX_PAYLOAD_BYTES.load(std::sync::atomic::Ordering::Relaxed)
}

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
    free_guard::record(user_ptr, payload_len, free_guard::AllocationKind::Header);

    user_ptr
}

/// Transfer an existing byte vector without copying it into the legacy FFI
/// header allocation. The paired `rustra_ffi_free_owned_bytes` reconstructs
/// this exact boxed slice from the returned pointer and length.
fn alloc_owned_bytes(data: Vec<u8>, out_len: *mut usize) -> *mut u8 {
    let boxed = data.into_boxed_slice();
    let len = boxed.len();
    unsafe { *out_len = len };
    let ptr = Box::into_raw(boxed) as *mut u8;
    #[cfg(debug_assertions)]
    free_guard::record(ptr, len, free_guard::AllocationKind::Owned);
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

    #[derive(Clone, Copy, Debug, Hash, PartialEq, Eq)]
    pub(super) enum AllocationKind {
        Header,
        Owned,
    }

    /// Classification of a `rustra_ffi_free` request against the live set.
    #[derive(Debug, PartialEq, Eq)]
    pub(super) enum Verdict {
        /// Exact `(ptr, len)` match — sound. Entry removed from the live set.
        Sound,
        /// `ptr` is live but under a different length (wrong-len free → UB).
        WrongLen,
        /// The pointer/length pair belongs to the other Rustra allocator.
        WrongAllocator,
        /// `ptr` is not live at all (double-free or foreign pointer → UB).
        NotLive,
    }

    fn live() -> &'static Mutex<HashSet<(usize, usize, AllocationKind)>> {
        static LIVE: OnceLock<Mutex<HashSet<(usize, usize, AllocationKind)>>> = OnceLock::new();
        LIVE.get_or_init(|| Mutex::new(HashSet::new()))
    }

    /// Record a freshly handed-out allocation.
    pub(super) fn record(ptr: *mut u8, len: usize, kind: AllocationKind) {
        let mut set = live().lock().expect("free_guard mutex poisoned");
        set.insert((ptr as usize, len, kind));
    }

    /// Classify a free request; on [`Verdict::Sound`] the entry is removed.
    ///
    /// Pure classification — never panics, so it is safe to call from inside the
    /// `extern "C"` boundary (which cannot unwind). The caller decides how to
    /// react to a misuse verdict.
    pub(super) fn check(ptr: *mut u8, len: usize, kind: AllocationKind) -> Verdict {
        let key = (ptr as usize, len, kind);
        let mut set = live().lock().expect("free_guard mutex poisoned");
        if set.remove(&key) {
            Verdict::Sound
        } else if set
            .iter()
            .any(|(p, entry_len, _)| *p == ptr as usize && *entry_len == len)
        {
            Verdict::WrongAllocator
        } else if set.iter().any(|(p, _, _)| *p == ptr as usize) {
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
        use super::{AllocationKind, Verdict, check, record};

        // 고유 synthetic 포인터 — dereference 되지 않고 key 로만 사용.
        const fn p(n: usize) -> *mut u8 {
            (0xdead_beef_0000 + n) as *mut u8
        }

        #[test]
        fn exact_match_is_sound_and_removes_entry() {
            record(p(0x10), 16, AllocationKind::Header);
            assert_eq!(check(p(0x10), 16, AllocationKind::Header), Verdict::Sound);
            // 이미 제거됨 → 같은 요청은 이제 NotLive.
            assert_eq!(check(p(0x10), 16, AllocationKind::Header), Verdict::NotLive);
        }

        #[test]
        fn same_ptr_different_len_is_wrong_len() {
            record(p(0x20), 32, AllocationKind::Header);
            assert_eq!(
                check(p(0x20), 33, AllocationKind::Header),
                Verdict::WrongLen,
                "ptr live under len=32 must classify len=33 as WrongLen"
            );
            // 정리: 올바른 len 으로 Sound 제거.
            assert_eq!(check(p(0x20), 32, AllocationKind::Header), Verdict::Sound);
        }

        #[test]
        fn second_free_is_not_live() {
            record(p(0x30), 8, AllocationKind::Owned);
            assert_eq!(check(p(0x30), 8, AllocationKind::Owned), Verdict::Sound);
            assert_eq!(
                check(p(0x30), 8, AllocationKind::Owned),
                Verdict::NotLive,
                "double-free must classify as NotLive"
            );
        }

        #[test]
        fn unknown_ptr_is_not_live() {
            assert_eq!(
                check(p(0x99), 64, AllocationKind::Header),
                Verdict::NotLive,
                "foreign pointer never recorded must be NotLive"
            );
        }

        #[test]
        fn exact_pair_from_other_allocator_is_rejected_without_removing_it() {
            record(p(0x40), 64, AllocationKind::Owned);
            assert_eq!(
                check(p(0x40), 64, AllocationKind::Header),
                Verdict::WrongAllocator
            );
            assert_eq!(check(p(0x40), 64, AllocationKind::Owned), Verdict::Sound);
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
pub(crate) fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
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
            error: Some(panic_frame_message(&*payload)),
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

/// 취소 체크포인트가 통합된 async 워커 dispatch (양쪽 async 엔트리 공용).
///
/// [`crate::cancel`] 레지스트리를 dispatch 직전에 조회해 `Cancelled` 상태면
/// 핸들러(`invoke_fn`)를 실행하지 않고 `cancelled` 에러 프레임을 만들어
/// `on_complete` 로 전달한다. 협력적 취소 계약:
///
/// - **체크포인트 전 취소** — 핸들러 미시작, `cancelled: ...` 에러 응답.
/// - **체크포인트 통과 후 취소** — 핸들러는 끝까지 실행되고 정상 결과 전달.
///
/// 체크포인트는 "cancel 이 먼저였으면 핸들러가 절대 시작하지 않는다"만
/// 보장한다. 응답 포맷 정합성을 위해 프레임 생성은 `serialize`(`err_response`
/// 와 동일한 경로)에 맡긴다 — JSON 경로는 `json_serialize`, postcard 경로는
/// `postcard_serialize_response` 를 넘긴다. `serialize` 는 `invoke_fn` 의
/// 응답 포맷과 일치해야 한다 (호스트가 두 경로의 프레임을 동일하게 디코딩).
///
/// `complete_invocation` 을 `on_complete` 이전에 호출한다 — 콜백 실행 중
/// 호스트가 `rustra_ffi_cancellation_status` 로 조회하면 이미 Unknown(0)을
/// 보게 되어 완결 순서가 명확해진다.
///
/// 완료는 Drop guard 로 구조적으로 보장된다 — 워커가 잔여 패닉(예: 취소
/// 레지스트리 락 포이즈닝 시 `status`/`complete_invocation` 의 expect)으로
/// 끝나도 엔트리 정리가 누락되지 않는다. 핸들러 패닉 자체는 `invoke_fn` 이
/// 가리키는 sync 진입점들의 `with_panic_guard` 가 에러 프레임으로 정규화한다
/// (unwind 없이 복귀). guard 의 drop 을 콜백 직전에 명시해 완료→콜백 순서를
/// 유지한다 — 호스트 콜백이 경계를 위반해도 complete 는 이미 실행된 상태다.
///
/// 완료 보장 guard 자체는 양쪽 async 워커(`run_worker`/`run_worker_into`)가
/// 파일 수준의 [`EnsureComplete`] 하나를 공유한다.
struct EnsureComplete(u64);
impl Drop for EnsureComplete {
    fn drop(&mut self) {
        crate::cancel::complete_invocation(self.0);
    }
}

fn run_worker(
    id: u64,
    bytes: Vec<u8>,
    user_data_raw: usize,
    on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
    invoke_fn: unsafe extern "C" fn(*const u8, usize, *mut usize) -> *mut u8,
    serialize: fn(&FfiResponse) -> Vec<u8>,
) {
    let _ensure = EnsureComplete(id);
    let mut out_len = 0;
    let resp_ptr = if crate::cancel::status(id) == crate::cancel::Status::Cancelled {
        err_response(
            &crate::RustraError::cancelled("invocation cancelled before dispatch").to_string(),
            &mut out_len,
            serialize,
        )
    } else {
        unsafe { invoke_fn(bytes.as_ptr(), bytes.len(), &mut out_len) }
    };
    // 완료→콜백 순서 계약: guard 를 여기서 명시적으로 풀어 complete_invocation
    // 이 on_complete 이전에 실행됨을 보장한다.
    drop(_ensure);
    if let Some(cb) = on_complete {
        unsafe { cb(user_data_raw as *mut c_void, resp_ptr, out_len) };
    } else if !resp_ptr.is_null() {
        unsafe { rustra_ffi_free(resp_ptr, out_len) };
    }
}

/// caller-buffer async 워커 dispatch — [`run_worker`] 와 동일한 계약(취소
/// 체크포인트, complete→callback 순서, exactly-once)을 호출자 버퍼 변형으로
/// 실행한다.
///
/// 응답 크기가 `capacity` 이하면 `Package::invoke_rkyv_v2_into` 가 caller
/// 버퍼에 직접 기록하고 `owned=0` 으로 전달한다 — Rust heap 할당과 복사가
/// 없다. 부족하면 **같은 dispatch 안에서** heap 프레임으로 폴백해
/// `owned=1` 로 전달한다. sync `_into` 처럼 재시도로 돌아오지 않는다:
/// 재시도는 다른 워커 스레드에 배정될 수 있어(2워커 풀) thread-local probe
/// 캐시가 미스나며 비멱등 핸들러가 재실행된다. 단일 dispatch + owned 폴백은
/// 이 경합을 구조적으로 제거한다 — 핸들러는 어떤 경우에도 1회만 실행된다.
///
/// null 콜백이면 owned 프레임만 즉시 해제한다(caller 버퍼는 호스트 소유 —
/// 건드리지 않는다).
fn run_worker_into(job: AsyncIntoJob) {
    let AsyncIntoJob {
        id,
        bytes,
        buf_raw,
        capacity,
        user_data_raw,
        on_complete,
    } = job;
    let buf = buf_raw as *mut u8;
    let _ensure = EnsureComplete(id);

    let (resp_ptr, resp_len, owned) = if crate::cancel::status(id)
        == crate::cancel::Status::Cancelled
    {
        let frame = crate::encode_rkyv_v2_error(&crate::RustraError::cancelled(
            "invocation cancelled before dispatch",
        ));
        deliver_into_frame(frame, buf, capacity)
    } else {
        // null caller buffer — owned 프레임으로만 전달할 수 있다.
        let target: &mut [u8] = if buf.is_null() {
            &mut []
        } else {
            unsafe { std::slice::from_raw_parts_mut(buf, capacity) }
        };
        let direct = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            get_package()
                .ok_or_else(|| {
                    crate::RustraError::custom("ffi.not_registered", "package not registered")
                })
                .and_then(|pkg| pkg.invoke_rkyv_v2_into(&bytes, target))
        })) {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                crate::rkyv_codec::DirectResponse::Buffered(crate::encode_rkyv_v2_error(&error))
            }
            Err(panic) => crate::rkyv_codec::DirectResponse::Buffered(crate::encode_rkyv_v2_error(
                &crate::RustraError::internal(panic_frame_message(&*panic)),
            )),
        };
        match direct {
            crate::rkyv_codec::DirectResponse::Written(written) => (buf, written, 0u8),
            crate::rkyv_codec::DirectResponse::Buffered(response) => {
                deliver_into_frame(response, buf, capacity)
            }
        }
    };

    // 완료→콜백 순서 계약 — run_worker 와 동일.
    drop(_ensure);
    if let Some(cb) = on_complete {
        unsafe { cb(user_data_raw as *mut c_void, resp_ptr, resp_len, owned) };
    } else if owned == 1 && !resp_ptr.is_null() {
        // 콜백이 없으면 소유권을 넘길 대상이 없다 — owned 프레임만 해제한다.
        // caller 버퍼(owned=0)는 호스트 소유라 해제하지 않는다.
        unsafe { rustra_ffi_free(resp_ptr, resp_len) };
    }
}

/// 응답 프레임 전달 규칙 — 들어가면 caller 버퍼로 복사(owned=0, 호스트가
/// 해제하지 않는다), 안 들어가면 `alloc_response` 포장으로 owned=1
/// (`rustra_ffi_free` 짝 — 기존 async 경로와 동일한 free 함수 하나로 수렴).
/// cancelled/error 프레임도 이 한 규칙을 따른다.
fn deliver_into_frame(frame: Vec<u8>, buf: *mut u8, capacity: usize) -> (*mut u8, usize, u8) {
    let needed = frame.len();
    if !buf.is_null() && capacity >= needed {
        unsafe { std::ptr::copy_nonoverlapping(frame.as_ptr(), buf, needed) };
        return (buf, needed, 0);
    }
    let mut out_len = 0usize;
    let ptr = alloc_response(frame, &mut out_len);
    (ptr, out_len, 1)
}

// ── async 워커 풀 (백프레셔 포함) ────────────────────────────
//
// 호출당 `std::thread::spawn` 은 burst 시 스레드 폭증(fd 고갈, 스케줄 지연)을
// 일으킨다. 이 풀은 고정 크기 워커 + bounded 채널로 대체한다 — 큐가 가득 차면
// 즉시 `invoke.backpressure` 에러 프레임으로 거부해 호출자(JsPromise)가 hang
// 없이 실패한다.

/// 워커 수 — RN/임베디드 호스트의 과도한 스레드 생성을 막는 고정 상수.
/// 코어 수 기반 스케일링은 호스트 런타임과 조율이 필요해 과잉 — 2로 시작해
/// 필요 시 노출한다.
const ASYNC_POOL_SIZE: usize = 2;
/// 큐 깊이 — 이 이상의 백로그는 backpressure 로 즉시 거부한다.
const ASYNC_QUEUE_DEPTH: usize = 256;

type AsyncJob = (
    u64,
    Vec<u8>,
    usize,
    Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
    unsafe extern "C" fn(*const u8, usize, *mut usize) -> *mut u8,
    fn(&FfiResponse) -> Vec<u8>,
);

/// caller-buffer 비동기 잡 — [`run_worker_into`] 가 소비한다.
/// `buf`/`capacity` 는 호출자(호스트)가 소유한 응답 버퍼로, 완료 콜백이
/// 실행되는 동안 살아 있음이 FFI 계약으로 보장된다(콜백이 버퍼를 소비한 뒤
/// 호스트가 해제한다). `buf_raw` 는 raw 포인터 대신 `usize` 로 담는다 —
/// 기존 `user_data` 와 같은 관례로 잡이 `Send` 를 만족하게 한다(포인터를
/// 스레드 간 전달하는 것 자체는 FFI 계약상 안전 — 호스트가 콜백 종료까지
/// 수명을 보장한다).
struct AsyncIntoJob {
    id: u64,
    bytes: Vec<u8>,
    buf_raw: usize,
    capacity: usize,
    user_data_raw: usize,
    on_complete: Option<UnsafeIntoComplete>,
}

/// async into 완료 콜백 타입 — `(user_data, resp_ptr, resp_len, owned)`.
/// `owned=0` 이면 `resp_ptr` 은 호출자가 제공한 버퍼(호스트가 해제하지
/// 않는다), `owned=1` 이면 Rust heap 프레임(`rustra_ffi_free` 로 해제).
type UnsafeIntoComplete = unsafe extern "C" fn(*mut c_void, *mut u8, usize, u8);

/// 두 종류의 async 잡 — 기존 alloc 경로(튜플)와 caller-buffer 경로(구조체)를
/// 같은 풀/워커에서 실행한다.
enum AsyncTask {
    Alloc(AsyncJob),
    Into(AsyncIntoJob),
}

fn async_pool() -> &'static Mutex<std::sync::mpsc::SyncSender<AsyncTask>> {
    static POOL: OnceLock<Mutex<std::sync::mpsc::SyncSender<AsyncTask>>> = OnceLock::new();
    POOL.get_or_init(|| {
        let (tx, rx) = std::sync::mpsc::sync_channel::<AsyncTask>(ASYNC_QUEUE_DEPTH);
        // 수신자를 Arc 로 공유해 각 워커가 lock-recv 로 잡는다 — Mutex 가 잠기는
        // 동안 다른 워커는 대기하지만 recv 자체가 블로킹이라 실제 경합은 짧다.
        let rx = std::sync::Arc::new(Mutex::new(rx));
        for _ in 0..ASYNC_POOL_SIZE {
            let rx = std::sync::Arc::clone(&rx);
            std::thread::spawn(move || {
                loop {
                    let job = {
                        let guard = rx.lock().unwrap_or_else(|p| p.into_inner());
                        guard.recv()
                    };
                    match job {
                        Ok(AsyncTask::Alloc((
                            id,
                            bytes,
                            user_data_raw,
                            on_complete,
                            invoke_fn,
                            serialize,
                        ))) => {
                            run_worker(id, bytes, user_data_raw, on_complete, invoke_fn, serialize);
                        }
                        Ok(AsyncTask::Into(job)) => run_worker_into(job),
                        Err(_) => break, // 송신자 전원 해제(프로세스 종료) — 워커 종료
                    }
                }
            });
        }
        Mutex::new(tx)
    })
}

/// 풀에 작업을 제출한다 — 큐가 가득 차면 Err(백프레셔). 호출자는
/// `invoke.backpressure` 프레임으로 정규화한다.
fn async_pool_submit(job: AsyncTask) -> Result<(), AsyncTask> {
    let tx = async_pool()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    tx.try_send(job).map_err(|e| match e {
        std::sync::mpsc::TrySendError::Full(job) => job,
        std::sync::mpsc::TrySendError::Disconnected(job) => job,
    })
}

/// `rustra_ffi_invoke` 의 디폴트 포맷 디스패치를 그대로 따르는 직렬화기 —
/// [`run_worker`] 의 cancelled 프레임이 실제 dispatch 경로와 동일한
/// 포맷(JSON/postcard)으로 인코딩되도록 한다. `None => Json` 기본값은
/// `rustra_ffi_invoke` 의 디스패치와 정확히 미러링되어야 한다 (디폴트
/// 미설정 시 두 경로가 같은 포맷을 산출).
fn sync_serialize(resp: &FfiResponse) -> Vec<u8> {
    match FFI_CONTEXT.get().map(|context| context.default_format) {
        Some(FfiFormat::Postcard) => postcard_serialize_response(resp),
        Some(FfiFormat::Json) | None => json_serialize(resp),
    }
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

    match FFI_CONTEXT.get().map(|context| context.default_format) {
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
    if payload_len > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        return err_response(&e.to_string(), out_len, json_serialize);
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

/// (성능 후속) caller-buffer JSON 변형 — 응답의 3중 복사 제거.
///
/// `buf` 가 null 이면 필요한 응답 크기를 `out_len` 에 쓰고 0 을 반환한다
/// (size-probe). `buf` 가 non-null 이면 응답을 `buf` 에 직접 기록하고 기록한
/// 바이트 수를 `out_len` 에 쓴다 — Rust 는 응답을 할당하지 않고 caller 가
/// 소유한 버퍼에 한 번만 쓴다 (malloc→복사→caller memcpy 사이클 제거).
///
/// 버퍼가 부족하면(`capacity` < 필요 크기) `out_len` 에 필요 크기를 쓰고
/// -1(`usize::MAX`)을 반환한다 — caller 가 다시 size-probe 하도록.
///
/// # Safety
///
/// `payload` must point to at least `payload_len` readable bytes.
/// `buf`, when non-null, must point to at least `capacity` writable bytes.
/// `out_len` must be a valid write pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_json_into(
    payload: *const u8,
    payload_len: usize,
    buf: *mut u8,
    capacity: usize,
    out_len: *mut usize,
) -> usize {
    if out_len.is_null() {
        return usize::MAX;
    }
    if payload.is_null() {
        unsafe { *out_len = 0 };
        return usize::MAX;
    }
    // size-probe: 임시 할당을 피하기 위해 실제 직렬화 결과 크기가 필요하다.
    // dispatch 를 한 번 실행하고 결과를 직접 caller 버퍼(또는 임시 Vec)에 쓴다.
    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    if buf.is_null() {
        // probe 단계 — 결과를 키와 함께 캐시해 이어지는 write 단계가 dispatch 를
        // 재실행하지 않게 한다(비멱등 핸들러의 사이드 이펙트 2회 방지).
        let resp = dispatch_into_bytes(bytes);
        unsafe { *out_len = resp.len() };
        json_probe_cache_store(bytes, resp);
        return 0;
    }

    // write 단계 — 같은 payload 의 probe 결과가 있으면 재사용(핸들러 1회
    // 실행 보장), 없으면(호출자가 probe 없이 바로 write) dispatch 를 실행한다.
    let response = match json_probe_cache_take(bytes) {
        Some(cached) => cached,
        None => dispatch_into_bytes(bytes),
    };

    let needed = response.len();
    unsafe { *out_len = needed };
    if capacity < needed {
        // 호출자가 작은 버퍼로 재시도해도 probe 결과를 잃지 않는다. 다음 write가
        // 같은 응답을 소비하므로 비멱등 핸들러는 여전히 정확히 1회만 실행된다.
        json_probe_cache_store(bytes, response);
        return usize::MAX; // 버퍼 부족 — 다시 probe 하라
    }
    unsafe { std::ptr::copy_nonoverlapping(response.as_ptr(), buf, needed) };
    needed
}

/// caller-buffer 경로의 dispatch — payload 검사/디코딩/패닉 가드를
/// `rustra_ffi_invoke_json` 과 동일하게 수행하고 응답 바이트를 반환한다.
fn dispatch_into_bytes(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(bytes.len(), max_payload_bytes());
        return json_serialize(&err_frame(&e.to_string()));
    }
    match json_deserialize_envelope(bytes) {
        Ok(env) => {
            // 패닉 가드는 기존 경로와 동일(`with_panic_guard` 와 같은 메시지
            // 포맷) — dispatch_json 이 패닉하면 에러 프레임으로 변환한다.
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                dispatch_json(&env.command, env.args)
            }));
            match result {
                Ok(resp) => json_serialize(&resp),
                Err(panic) => json_serialize(&err_frame(&panic_frame_message(panic.as_ref()))),
            }
        }
        Err(e) => json_serialize(&err_frame(&e)),
    }
}

/// 에러 응답 프레임 직렬화 공용 헬퍼 — `err_response` 는 FFI 버퍼 할당 경로라
/// caller-buffer 에서는 이 헬퍼로 대체한다.
fn err_frame(msg: &str) -> FfiResponse {
    FfiResponse {
        ok: false,
        result: None,
        error: Some(msg.to_string()),
    }
}

/// 패닉을 단일 포맷의 에러 프레임 메시지로 정규화한다 — `with_panic_guard` 와
/// caller-buffer 경로가 공유한다. 호스트 측 파서가 prefix 로 분류하므로 포맷이
/// 경로별로 갈라지면 안 된다 (과거 "internal: panic — …" / "panic in handler: …"
/// 두 종류가 공존했다).
fn panic_frame_message(payload: &(dyn std::any::Any + Send)) -> String {
    format!("internal: panic — {}", panic_message(payload))
}

/// caller-buffer size-probe 결과의 1회 실행 캐시.
///
/// probe(buf=null) → write(buf) 2단계 프로토콜에서 각 단계가 dispatch 를
/// 재실행하면 비멱등 핸들러(카운터 증가, 결제)의 사이드 이펙트가 2번 발생한다.
/// probe 가 직렬화한 응답을 여기 보관하면 이어지는 write 호출이 dispatch 없이
/// 같은 바이트를 caller 버퍼에 복사한다. 단일 호출 흐름(probe 직후 write)을
/// 전제로 마지막 1건만 보관한다 — probe 후 다른 명령을 probe 하면 이전 캐시는
/// 덮어써진다(잘못된 응답 재사용 없음).
///
/// 보관된 probe 결과를 꺼낸다(소비). 해시가 아니라 요청 바이트 전체를 비교해
/// 충돌로 다른 명령의 응답이 전달될 가능성을 없앤다. JSON/rkyv V2 슬롯도
/// 분리해 한 API의 probe가 다른 API의 캐시를 덮어쓰지 않는다.
struct ProbeCacheEntry {
    request: Vec<u8>,
    response: Vec<u8>,
}

fn probe_cache_take(
    cache: &'static std::thread::LocalKey<std::cell::RefCell<Option<ProbeCacheEntry>>>,
    payload: &[u8],
) -> Option<Vec<u8>> {
    cache.with(|slot| {
        let entry = slot.borrow_mut().take()?;
        (entry.request == payload).then_some(entry.response)
    })
}

fn probe_cache_store(
    cache: &'static std::thread::LocalKey<std::cell::RefCell<Option<ProbeCacheEntry>>>,
    payload: &[u8],
    response: Vec<u8>,
) {
    cache.with(|slot| {
        *slot.borrow_mut() = Some(ProbeCacheEntry {
            request: payload.to_vec(),
            response,
        });
    });
}

fn json_probe_cache_take(payload: &[u8]) -> Option<Vec<u8>> {
    probe_cache_take(&JSON_PROBE_CACHE, payload)
}

fn json_probe_cache_store(payload: &[u8], response: Vec<u8>) {
    probe_cache_store(&JSON_PROBE_CACHE, payload, response);
}

fn rkyv_probe_cache_take(payload: &[u8]) -> Option<Vec<u8>> {
    probe_cache_take(&RKYV_V2_PROBE_CACHE, payload)
}

fn rkyv_probe_cache_store(payload: &[u8], response: Vec<u8>) {
    probe_cache_store(&RKYV_V2_PROBE_CACHE, payload, response);
}

thread_local! {
    static JSON_PROBE_CACHE: std::cell::RefCell<Option<ProbeCacheEntry>> = const { std::cell::RefCell::new(None) };
    static RKYV_V2_PROBE_CACHE: std::cell::RefCell<Option<ProbeCacheEntry>> = const { std::cell::RefCell::new(None) };
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
    if payload_len > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        return err_response(&e.to_string(), out_len, postcard_serialize_response);
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
/// 호출마다 취소 레지스트리([`crate::cancel`])에 invocation_id 를 발급한다 —
/// `invocation_id` 가 non-null 이면 그 버퍼로 복사되고, 이 ID 로
/// [`rustra_ffi_invoke_cancel`] / [`rustra_ffi_cancellation_status`] 를 호출할 수
/// 있다. null 포인터를 넘기면 ID 발급은 일어나지만 호출자에게 노출되지 않는다.
///
/// **dispatch 취소 체크포인트**: 워커가 핸들러를 실행하기 직전에 레지스트리를
/// 조회한다. cancel 이 체크포인트보다 먼저 도달했으면 핸들러는 시작하지 않고
/// `cancelled: ...` 에러 프레임이 `on_complete` 로 전달된다 (디폴트 포맷으로
/// 인코딩 — postcard 등록 시 `FfiPostcardResponse` 프레임). 체크포인트 통과
/// 후의 cancel 은 결과에 반영되지 않는다 — 핸들러는 끝까지 실행되고 정상
/// 결과가 전달된다.
///
/// # Safety
///
/// - `payload` must point to `payload_len` valid bytes (or null if len 0).
/// - `on_complete` must be a thread-safe C callback function pointer.
/// - `invocation_id` must be null or a valid u64 write pointer (out-param).
/// - The caller must free `response_ptr` using `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_async(
    payload: *const u8,
    payload_len: usize,
    user_data: *mut c_void,
    on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
    invocation_id: *mut u64,
) {
    let id = crate::cancel::register_invocation();
    if !invocation_id.is_null() {
        unsafe { *invocation_id = id };
    }
    let user_data_raw = user_data as usize;
    // 크기 게이트를 복사 전에 검사한다 — 초과 페이로드를 일단 복사해 메모리가
    // 일시적으로 2배가 되던 동작(주석이 스스로 인정하던 문제)을 제거한다.
    if payload_len > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            sync_serialize,
            &e.to_string(),
        );
        return;
    }
    let bytes = if payload.is_null() || payload_len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len).to_vec() }
    };

    // 고정 워커 풀로 제출(백프레셔 포함) — 호출당 thread::spawn 의 스레드 폭증을
    // 방지한다. 큐가 가득 차면 즉시 backpressure 프레임으로 거부한다(hang 없음).
    if async_pool_submit(AsyncTask::Alloc((
        id,
        bytes,
        user_data_raw,
        on_complete,
        rustra_ffi_invoke,
        sync_serialize,
    )))
    .is_err()
    {
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            sync_serialize,
            "invoke.backpressure: async worker queue is full — retry after drain",
        );
    }
}

/// Async JSON FFI invoke entry point.
///
/// [`rustra_ffi_invoke_async`] 와 동일한 계약 — invocation_id 발급/노출, 취소
/// 심볼 연동, **dispatch 취소 체크포인트**(cancel 먼저 → 핸들러 미실행,
/// JSON `cancelled: ...` 에러 프레임이 `on_complete` 로 전달)를 포함한다.
/// 디폴트 포맷 디스패치 대신 항상 JSON 경로로 invoke 한다.
///
/// # Safety
///
/// - `payload` must point to `payload_len` valid bytes (or null if len 0).
/// - `on_complete` must be a thread-safe C callback function pointer.
/// - `invocation_id` must be null or a valid u64 write pointer (out-param).
/// - The caller must free the response pointer in the callback using `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_json_async(
    payload: *const u8,
    payload_len: usize,
    user_data: *mut c_void,
    on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
    invocation_id: *mut u64,
) {
    let id = crate::cancel::register_invocation();
    if !invocation_id.is_null() {
        unsafe { *invocation_id = id };
    }
    let user_data_raw = user_data as usize;
    // 크기 게이트를 복사 전에 검사한다(위 async 엔트리와 동일).
    if payload_len > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            json_serialize,
            &e.to_string(),
        );
        return;
    }
    let bytes = if payload.is_null() || payload_len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len).to_vec() }
    };

    if async_pool_submit(AsyncTask::Alloc((
        id,
        bytes,
        user_data_raw,
        on_complete,
        rustra_ffi_invoke_json,
        json_serialize,
    )))
    .is_err()
    {
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            json_serialize,
            "invoke.backpressure: async worker queue is full — retry after drain",
        );
    }
}

/// async 엔트리에서 워커 spawn 에 실패했을 때 완료를 에러 프레임으로 전달한다.
///
/// `run_worker` 의 완료 경로(complete_invocation → on_complete)를 동일하게
/// 밟는다 — 호출자의 콜백 계약(정확히 1회 호출, 버퍼는 rustra_ffi_free 로
/// 해제)이 유지되고 레지스트리 엔트리도 정리된다.
fn deliver_spawn_failure(
    id: u64,
    user_data_raw: usize,
    on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
    serialize: fn(&FfiResponse) -> Vec<u8>,
    message: &str,
) {
    let frame = err_frame(message);
    let bytes = serialize(&frame);
    let mut out_len = bytes.len();
    let ptr = alloc_response(bytes, &mut out_len);
    crate::cancel::complete_invocation(id);
    if let Some(cb) = on_complete {
        unsafe { cb(user_data_raw as *mut c_void, ptr, out_len) };
    } else if !ptr.is_null() {
        // 콜백이 없으면 소유권을 넘길 대상이 없다. 성공 워커의 null-callback
        // 경로와 동일하게 즉시 해제해 payload-too-large/backpressure 반복 시
        // 응답 버퍼가 누적되지 않게 한다.
        unsafe { rustra_ffi_free(ptr, out_len) };
    }
}

/// 진행 중인 async 호출을 취소한다 (협력적).
///
/// `Running` 상태의 호출만 취소 가능 — 이미 완료/취소된 ID는 false 반환.
/// 취소는 플래그 전환만 하고 스레드를 강제 종료하지 않는다.
///
/// 취소는 dispatch 체크포인트에서만 응답에 반영된다 — cancel 이 워커의
/// 체크포인트보다 먼저면 핸들러는 시작하지 않고 `cancelled` 에러 프레임이
/// `on_complete` 로 전달된다. 핸들러가 이미 시작했다면 취소는 결과를 바꾸지
/// 않는다: 실행은 끝까지 진행되고 정상 결과가 전달된다.
///
/// # Safety
///
/// 이 함수는 안전하게 호출할 수 있다(unsafe 는 `extern "C"` ABI 선언의 산물).
/// 어떤 u64 값도 안전하다 — 알 수 없거나 이미 완료/취소된 ID 는 false 로
/// 정규화된다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_cancel(invocation_id: u64) -> bool {
    crate::cancel::cancel_invocation(invocation_id)
}

/// 호출의 취소 상태 조회 (핸들러 내부 협력적 중단 폴링용).
///
/// 반환값: 0=Unknown(완료/미발급), 1=Running, 2=Cancelled.
///
/// # Safety
///
/// 이 함수는 안전하게 호출할 수 있다(unsafe 는 `extern "C"` ABI 선언의 산물).
/// 어떤 u64 값도 정의된 상태 코드로 정규화된다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_cancellation_status(invocation_id: u64) -> u32 {
    match crate::cancel::status(invocation_id) {
        crate::cancel::Status::Unknown => 0,
        crate::cancel::Status::Running => 1,
        crate::cancel::Status::Cancelled => 2,
    }
}

/// (T3) 페이로드 크기 한도를 동적으로 변경한다. 기본 1 MiB
/// ([`DEFAULT_MAX_PAYLOAD_BYTES`]). 축소/확대 모두 즉시 이후의
/// `rustra_ffi_invoke_json` / `rustra_ffi_invoke_postcard` 호출에 반영된다.
/// 비동기 변형(`rustra_ffi_invoke_async`/`_json_async`)은 호출자 스레드에서
/// 페이로드를 먼저 복사한 뒤에야 워커에서 검사한다 — 초과 페이로드도 일단
/// 복사되므로 일시적으로 메모리가 2배로 존재할 수 있다. 어떤 스레드든 호출할
/// 수 있고, 동시 set 간 경합은 last-writer-wins 이다.
///
/// `Relaxed` — 크기 게이트는 어림잡기(sanity gate) 용도라 원자성만 필요하고
/// 다른 메모리와의 순서 관계는 요구되지 않는다. 진행 중인 호출은 이미 읽은
/// 이전 한도로 검사를 마친 상태일 수 있다 (한도는 새 호출부터 적용).
///
/// # Safety
///
/// 어떤 값도 안전하다 — 0 으로 설정하면 모든 페이로드가 거부된다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_set_max_payload(bytes: usize) {
    MAX_PAYLOAD_BYTES.store(bytes, std::sync::atomic::Ordering::Relaxed);
}

/// (T3) 현재 페이로드 크기 한도. [`rustra_ffi_set_max_payload`] 로 설정한
/// 값 또는 기본 1 MiB.
///
/// # Safety
///
/// 이 함수는 안전하게 호출할 수 있다(unsafe 는 `extern "C"` ABI 선언의 산물).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_get_max_payload() -> usize {
    max_payload_bytes()
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
pub unsafe extern "C" fn rustra_ffi_free(ptr: *mut u8, _len: usize) {
    if !ptr.is_null() {
        #[cfg(debug_assertions)]
        match free_guard::check(ptr, _len, free_guard::AllocationKind::Header) {
            free_guard::Verdict::Sound => {}
            verdict => {
                eprintln!(
                    "rustra_ffi_free: F2 misuse ({verdict:?}) for (ptr,len)=({ptr:p},{_len}) — \
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

/// Free the exact pointer/length pair returned by `rustra_ffi_invoke_buffer`.
/// This allocation has no hidden header and is deliberately not interchangeable
/// with [`rustra_ffi_free`].
///
/// # Safety
///
/// `ptr` and `len` must be the exact pair returned by
/// `rustra_ffi_invoke_buffer`, exactly once.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_free_owned_bytes(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    #[cfg(debug_assertions)]
    match free_guard::check(ptr, len, free_guard::AllocationKind::Owned) {
        free_guard::Verdict::Sound => {}
        verdict => {
            eprintln!(
                "rustra_ffi_free_owned_bytes: F2 misuse ({verdict:?}) for (ptr,len)=({ptr:p},{len})"
            );
            std::process::abort();
        }
    }
    let raw_slice = std::ptr::slice_from_raw_parts_mut(ptr, len);
    let _ = unsafe { Box::from_raw(raw_slice) };
}

/// rkyv V2 바이너리 와이어 진입점 — command_id(u16) 기반 dispatch.
///
/// 소비자마다 패닉 가드+버퍼 프로토콜을 복제해 구현하던 것(examples/calculator 의
/// `rustra_calculator_invoke_rkyv_v2` 등)을 코어가 대신 제공한다. 응답은
/// [`crate::encode_rkyv_v2_error`] 와 동일한 와이어(성공 시 ok=1 + postcard body).
/// 패닉은 `with_panic_guard` 계약대로 internal 에러 프레임으로 정규화된다.
///
/// # Safety
///
/// `payload` must point to at least `payload_len` readable bytes.
/// `out_len` must be a valid write pointer.
/// Caller must free the returned buffer with `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_rkyv_v2(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };
    // 패닉 가드는 한 겹이다 — 코어 invoke_rkyv_v2_command 가 핸들러 패닉을
    // internal 에러로 정규화한다. 이전의 바깥 catch_unwind 은 같은 패닉을
    // 두 번 가두며 unwind 테이블 세팅 비용만 핫패스에 남겼다. 레지스트리
    // 조회(BTreeMap get)와 슬라이스 생성은 패닉 불가능한 코어 제어 코드다.
    let resp = match get_package()
        .ok_or_else(|| crate::RustraError::custom("ffi.not_registered", "package not registered"))
        .and_then(|pkg| pkg.invoke_rkyv_v2(bytes))
    {
        Ok(bytes) => bytes,
        Err(error) => crate::encode_rkyv_v2_error(&error),
    };
    alloc_response(resp, out_len)
}

/// Direct single-byte-field invocation. Success transfers the handler's owned
/// output vector without a postcard response frame; errors transfer a UTF-8
/// `RustraError` display string. Return value: 0 success, 1 command error,
/// `u32::MAX` invalid ABI arguments.
///
/// # Safety
///
/// - `payload` must be readable for `payload_len` bytes, or null when len is 0.
/// - `out_ptr` and `out_len` must be valid writable pointers.
/// - the returned pair must be freed with `rustra_ffi_free_owned_bytes`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_buffer(
    command_id: u16,
    payload: *const u8,
    payload_len: usize,
    out_ptr: *mut *mut u8,
    out_len: *mut usize,
) -> u32 {
    if out_ptr.is_null() || out_len.is_null() || (payload.is_null() && payload_len != 0) {
        return u32::MAX;
    }
    unsafe {
        *out_ptr = std::ptr::null_mut();
        *out_len = 0;
    }
    let bytes = if payload_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len) }
    };
    let result = get_package()
        .ok_or_else(|| crate::RustraError::custom("ffi.not_registered", "package not registered"))
        .and_then(|package| package.invoke_buffer(command_id, bytes));
    let (status, output) = match result {
        Ok(output) => (0, output),
        Err(error) => (1, error.to_string().into_bytes()),
    };
    let ptr = alloc_owned_bytes(output, out_len);
    unsafe { *out_ptr = ptr };
    status
}

/// Return 1 when the registered package owns a direct handler for `command_id`.
#[unsafe(no_mangle)]
pub extern "C" fn rustra_ffi_has_buffer(command_id: u16) -> u32 {
    u32::from(get_package().is_some_and(|package| package.has_buffer_handler(command_id)))
}

/// 스칼라 직결(raw) invoke — postcard 인코딩/디코딩 없이 u64 슬롯으로 주고받는다.
///
/// JSI 호스트의 `invokeTypedRaw(cmdId, ...args)` 진입과 짝을 이룬다. 슬롯
/// 배열은 인자 선언순 그대로(f64는 IEEE-754 비트 재해석, bool은 0/1). 결과
/// 슬롯은 `out_slot` 에 기록되고 반환값은 에러 코드다(0=성공, 그 외=에러).
/// 에러 상세는 기존 rkyv V2 에러 와이어([`crate::encode_rkyv_v2_error`])를
/// `err_buf`/`err_buf_cap` 에 복사하고 필요 크기를 `err_len` 에 쓴다 —
/// 부족하면 잘린 메시지라도 싣고 0이 아닌 코드를 반환한다.
///
/// 명령이 raw 조건(스칼라 1..3 입력 + 단일 스칼라/unit 출력)이 아니면
/// `u32::MAX`(폴백 신호)를 반환한다 — 호스트는 by-id 경로로 되돌린다.
///
/// # Safety
///
/// `slots` must point to at least `slot_count` readable u64 values.
/// `out_slot` and `err_len` must be valid write pointers.
/// `err_buf`, when non-null, must point to at least `err_buf_cap` writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_raw(
    command_id: u16,
    slots: *const u64,
    slot_count: usize,
    out_slot: *mut u64,
    err_buf: *mut u8,
    err_buf_cap: usize,
    err_len: *mut usize,
) -> u32 {
    if out_slot.is_null() || err_len.is_null() {
        return u32::MAX;
    }
    let Some(pkg) = get_package() else {
        unsafe { *err_len = 0 };
        return u32::MAX;
    };
    // raw 직결 불가 명령 폴백 신호 — 호스트가 by-id 경로로 되돌린다.
    if pkg.raw_invoke_shape(command_id).is_none() {
        unsafe { *err_len = 0 };
        return u32::MAX;
    }
    let slot_slice: &[u64] = if slots.is_null() || slot_count == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(slots, slot_count) }
    };
    match pkg.invoke_raw(command_id, slot_slice) {
        Ok(value) => {
            unsafe { *out_slot = value };
            unsafe { *err_len = 0 };
            0
        }
        Err(error) => {
            let wire = crate::encode_rkyv_v2_error(&error);
            let needed = wire.len();
            let copy = needed.min(err_buf_cap);
            if !err_buf.is_null() && copy > 0 {
                unsafe {
                    std::ptr::copy_nonoverlapping(wire.as_ptr(), err_buf, copy);
                }
            }
            unsafe { *err_len = needed };
            1
        }
    }
}

/// Returns 1 when the registered package has a raw scalar handler for the
/// numeric command id, otherwise 0. Hosts combine this runtime fact with their
/// generated codec metadata before advertising Tier 0 to JavaScript.
#[unsafe(no_mangle)]
pub extern "C" fn rustra_ffi_has_raw(command_id: u16) -> u8 {
    u8::from(
        get_package()
            .and_then(|pkg| pkg.raw_invoke_shape(command_id))
            .is_some(),
    )
}

/// rkyv V2 caller-buffer 변형 — JSI typed fast path 의 malloc→memcpy→free
/// 사이클 제거 경로.
///
/// `buf` 가 null 이면 필요한 응답 크기를 `out_len` 에 쓰고 0을 반환한다
/// (size-probe). `buf` 가 non-null 이면 응답을 `buf` 에 직접 기록하고 기록한
/// 바이트 수를 반환한다 — Rust 는 코어 FFI 레이아웃 버퍼를 할당하지 않는다.
/// 버퍼가 부족하면 `usize::MAX` 를 반환한다(재probe 신호).
///
/// probe → write 사이의 핸들러 1회 실행 보장은 JSON caller-buffer
/// ([`rustra_ffi_invoke_json_into`]) 와 동일한 probe 캐시를 공유하지 않는다 —
/// rkyv V2 와이어는 payload 가 바이너리 프레임이라 JSON 캐시 키와 다르다.
/// 대신 동일한 thread-local 슬롯(rkyv V2 전용)로 probe 결과를 재사용한다.
///
/// # Safety
///
/// `payload` must point to at least `payload_len` readable bytes.
/// `buf`, when non-null, must point to at least `capacity` writable bytes.
/// `out_len` must be a valid write pointer.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_rkyv_v2_into(
    payload: *const u8,
    payload_len: usize,
    buf: *mut u8,
    capacity: usize,
    out_len: *mut usize,
) -> usize {
    if out_len.is_null() {
        return usize::MAX;
    }
    if payload.is_null() {
        unsafe { *out_len = 0 };
        return usize::MAX;
    }
    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };

    if buf.is_null() {
        let resp = rkyv_v2_dispatch_bytes(bytes);
        unsafe { *out_len = resp.len() };
        rkyv_probe_cache_store(bytes, resp);
        return 0;
    }

    if let Some(response) = rkyv_probe_cache_take(bytes) {
        let needed = response.len();
        unsafe { *out_len = needed };
        if capacity < needed {
            rkyv_probe_cache_store(bytes, response);
            return usize::MAX;
        }
        unsafe { std::ptr::copy_nonoverlapping(response.as_ptr(), buf, needed) };
        return needed;
    }

    let target = unsafe { std::slice::from_raw_parts_mut(buf, capacity) };
    let direct = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        get_package()
            .ok_or_else(|| {
                crate::RustraError::custom("ffi.not_registered", "package not registered")
            })
            .and_then(|pkg| pkg.invoke_rkyv_v2_into(bytes, target))
    })) {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => {
            crate::rkyv_codec::DirectResponse::Buffered(crate::encode_rkyv_v2_error(&error))
        }
        Err(panic) => crate::rkyv_codec::DirectResponse::Buffered(crate::encode_rkyv_v2_error(
            &crate::RustraError::internal(panic_frame_message(&*panic)),
        )),
    };

    match direct {
        crate::rkyv_codec::DirectResponse::Written(written) => {
            unsafe { *out_len = written };
            written
        }
        crate::rkyv_codec::DirectResponse::Buffered(response) => {
            let needed = response.len();
            unsafe { *out_len = needed };
            if capacity < needed {
                rkyv_probe_cache_store(bytes, response);
                return usize::MAX;
            }
            unsafe { std::ptr::copy_nonoverlapping(response.as_ptr(), buf, needed) };
            needed
        }
    }
}

/// rkyv V2 caller-buffer 경로의 dispatch — 패닉 가드 포함, 응답 바이트 반환.
fn rkyv_v2_dispatch_bytes(bytes: &[u8]) -> Vec<u8> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        get_package()
            .ok_or_else(|| {
                crate::RustraError::custom("ffi.not_registered", "package not registered")
            })
            .and_then(|pkg| pkg.invoke_rkyv_v2(bytes))
    })) {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => crate::encode_rkyv_v2_error(&error),
        Err(panic) => {
            crate::encode_rkyv_v2_error(&crate::RustraError::internal(panic_frame_message(&*panic)))
        }
    }
}

/// rkyv V2 비동기 진입점 — [`rustra_ffi_invoke_async`] 와 동일한 계약
/// (invocation_id 발급, 워커 스레드 dispatch, cancel 체크포인트, complete 후
/// on_complete 1회)을 rkyv V2 와이어로 제공한다.
///
/// # Safety
///
/// - `payload` must point to `payload_len` valid bytes (or null if len 0).
/// - `on_complete` must be a thread-safe C callback function pointer.
/// - `invocation_id` must be null or a valid u64 write pointer (out-param).
/// - The caller must free `response_ptr` using `rustra_ffi_free`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_rkyv_v2_async(
    payload: *const u8,
    payload_len: usize,
    user_data: *mut c_void,
    on_complete: Option<unsafe extern "C" fn(*mut c_void, *mut u8, usize)>,
    invocation_id: *mut u64,
) {
    let id = crate::cancel::register_invocation();
    if !invocation_id.is_null() {
        unsafe { *invocation_id = id };
    }
    let user_data_raw = user_data as usize;
    if payload_len > max_payload_bytes() {
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            rkyv_error_bytes,
            &e.to_string(),
        );
        return;
    }
    let bytes = if payload.is_null() || payload_len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len).to_vec() }
    };

    if async_pool_submit(AsyncTask::Alloc((
        id,
        bytes,
        user_data_raw,
        on_complete,
        rustra_ffi_invoke_rkyv_v2,
        rkyv_error_bytes,
    )))
    .is_err()
    {
        deliver_spawn_failure(
            id,
            user_data_raw,
            on_complete,
            rkyv_error_bytes,
            "invoke.backpressure: async worker queue is full — retry after drain",
        );
    }
}

/// rkyv V2 비동기 caller-buffer 변형 — [`rustra_ffi_invoke_rkyv_v2_async`] 와
/// 동일한 계약(invocation_id 발급, 워커 스레드 dispatch, cancel 체크포인트,
/// complete 후 on_complete 1회)에 호스트 제공 응답 버퍼를 더한다.
///
/// `buf`/`capacity` — 호스트가 소유한 응답 버퍼. **수명 계약**: 호스트는
/// 완료 콜백이 실행되는 동안 버퍼를 살아 있게 유지해야 하며, 콜백이 돌아온
/// 뒤에 해제한다(호출 스레드는 즉시 반환하므로 버퍼를 스택에 둘 수 없다 —
/// 힙/persistent 버퍼여야 한다). 워커가 버퍼에 응답을 쓰는 동안 호스트는
/// 그 버퍼를 읽거나 다른 용도로 쓰지 않는다(단일 소유자 — dispatch 중).
///
/// 완료 콜백 `on_complete(user_data, resp_ptr, resp_len, owned)`:
/// - `owned=0` — `resp_ptr` 은 호스트가 넘긴 `buf` 자체다. 응답은 그 안에
///   있고 별도 해제는 없다.
/// - `owned=1` — 응답이 버퍼에 안 들어갔다(overflow 또는 null buf). Rust 가
///   heap 프레임을 새로 만들었으므로 호스트는 `rustra_ffi_free` 로 정확히
///   1회 해제해야 한다.
///
/// overflow 시에도 재시도(signalling) 프로토콜을 쓰지 않는다 — sync `_into`
/// 의 probe → write 2단계는 thread-local probe 캐시에 의존하는데, 재시도
/// 호출이 2워커 풀의 다른 스레드에 배정되면 캐시가 미스나 비멱등 핸들러가
/// 재실행된다. 대신 워커가 **같은 dispatch 안에서** heap 프레임으로 폴백해
/// owned=1 로 전달한다 — 핸들러는 항상 정확히 1회 실행된다.
///
/// # Safety
///
/// - `payload` must point to `payload_len` valid bytes (or null if len 0).
/// - `buf`, when non-null, must point to at least `capacity` writable bytes
///   and must outlive the completion callback (heap or persistent storage).
/// - `on_complete` must be a thread-safe C callback function pointer.
/// - `invocation_id` must be null or a valid u64 write pointer (out-param).
/// - When the callback reports `owned=1`, the caller must free `resp_ptr`
///   with `rustra_ffi_free`. With `owned=0` the pointer is the caller's own
///   buffer and must not be freed through the FFI.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_invoke_rkyv_v2_async_into(
    payload: *const u8,
    payload_len: usize,
    buf: *mut u8,
    capacity: usize,
    user_data: *mut c_void,
    on_complete: Option<UnsafeIntoComplete>,
    invocation_id: *mut u64,
) {
    let id = crate::cancel::register_invocation();
    if !invocation_id.is_null() {
        unsafe { *invocation_id = id };
    }
    let user_data_raw = user_data as usize;
    // 즉시 실패(payload-too-large / backpressure) 공용 완료 — 버퍼에 에러
    // 프레임을 복사할 수 있으면 owned=0, 아니면 owned=1. 콜백 1회 + 레지스트리
    // 정리 계약은 워커 경로(`run_worker_into`)와 동일하게 유지된다.
    let deliver_immediate = |frame: Vec<u8>| {
        let (ptr, len, owned) = deliver_into_frame(frame, buf, capacity);
        crate::cancel::complete_invocation(id);
        if let Some(cb) = on_complete {
            unsafe { cb(user_data_raw as *mut c_void, ptr, len, owned) };
        } else if owned == 1 && !ptr.is_null() {
            unsafe { rustra_ffi_free(ptr, len) };
        }
    };
    if payload_len > max_payload_bytes() {
        // 크기 게이트 실패는 호출 스레드에서 즉시 완료한다.
        let e = crate::RustraError::payload_too_large(payload_len, max_payload_bytes());
        deliver_immediate(crate::encode_rkyv_v2_error(&e));
        return;
    }
    let bytes = if payload.is_null() || payload_len == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(payload, payload_len).to_vec() }
    };

    if async_pool_submit(AsyncTask::Into(AsyncIntoJob {
        id,
        bytes,
        buf_raw: buf as usize,
        capacity,
        user_data_raw,
        on_complete,
    }))
    .is_err()
    {
        // 백프레셔도 동일한 즉시 완료 규칙을 따른다.
        let e = crate::RustraError::custom(
            "invoke.backpressure",
            "async worker queue is full — retry after drain",
        )
        .retryable();
        deliver_immediate(crate::encode_rkyv_v2_error(&e));
    }
}

/// rkyv V2 에러를 postcard 가 아닌 코어 에러 인코더로 감싸는 serialize 어댑터 —
/// `run_worker`/`deliver_spawn_failure` 는 `fn(&FfiResponse) -> Vec<u8>` 를
/// 기대하지만 rkyv V2 경로는 RustraError 를 직접 인코딩한다. 에러 문자열을
/// FfiResponse.error 에 실으면 수신측(JSON 파서)이 아니라 rkyv V2 디코더가
/// 읽는다 — run_worker 는 `invoke_fn` 이 반환한 버퍼를 그대로 on_complete 로
/// 전달하므로 이 어댑터는 에러 프레임만 만들면 된다.
fn rkyv_error_bytes(resp: &FfiResponse) -> Vec<u8> {
    let raw = resp.error.as_deref().unwrap_or("invoke failed");
    let (code, message) = raw
        .split_once(": ")
        .map_or(("invoke.failed", raw), |(code, message)| (code, message));
    // FFI Display 문자열을 rkyv typed error로 다시 만들 때 안정 코드와
    // retryable 기본 의미를 보존한다. 임의 사용자 코드는 &'static str 계약상
    // 재구성할 수 없으므로 invoke.failed로 안전하게 폴백한다.
    let error = match code {
        "cancelled" => crate::RustraError::cancelled(message),
        "transport.error" => crate::RustraError::transport(message),
        "transport.timeout" => crate::RustraError::timeout(message),
        "command.not_found" => crate::RustraError::custom("command.not_found", message),
        "command.invalid_args" => crate::RustraError::custom("command.invalid_args", message),
        "capability.denied" => crate::RustraError::custom("capability.denied", message),
        "payload.too_large" => crate::RustraError::custom("payload.too_large", message),
        "internal" => crate::RustraError::internal(message),
        "invoke.backpressure" => {
            crate::RustraError::custom("invoke.backpressure", message).retryable()
        }
        _ => crate::RustraError::custom("invoke.failed", raw),
    };
    crate::encode_rkyv_v2_error(&error)
}
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

/// 등록된 C 콜백 + 호스트 소유 `user_data`와 quiescence 상태.
struct FfiEventSinkInner {
    callback: FfiEventCallback,
    #[allow(clippy::trivially_copy_pass_by_ref)]
    user_data: *mut c_void,
    activity: Mutex<FfiEventActivity>,
    quiescent: std::sync::Condvar,
}

#[derive(Default)]
struct FfiEventActivity {
    enabled: bool,
    active_calls: usize,
}

#[derive(Clone)]
struct FfiEventSink(std::sync::Arc<FfiEventSinkInner>);

/// `FfiEventSinkInner.user_data` 는 호스트 소유 원시 포인터 — Rust 이동/빌림 규칙
/// 밖이다. 콜백 래퍼에서만 값으로 취급(역참조 없음)하므로 `Send + Sync` 선언이
/// 안전하다.
unsafe impl Send for FfiEventSinkInner {}
unsafe impl Sync for FfiEventSinkInner {}

struct FfiEventCallGuard<'a>(&'a FfiEventSinkInner);

impl Drop for FfiEventCallGuard<'_> {
    fn drop(&mut self) {
        let mut activity = self
            .0
            .activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        activity.active_calls = activity.active_calls.saturating_sub(1);
        if activity.active_calls == 0 {
            self.0.quiescent.notify_all();
        }
    }
}

impl FfiEventSink {
    fn new(callback: FfiEventCallback, user_data: *mut c_void) -> Self {
        Self(std::sync::Arc::new(FfiEventSinkInner {
            callback,
            user_data,
            activity: Mutex::new(FfiEventActivity {
                enabled: true,
                active_calls: 0,
            }),
            quiescent: std::sync::Condvar::new(),
        }))
    }

    /// 저장된 콜백을 C ABI 로 호출한다. 문자열은 NUL 종료로 변환해 전달한다.
    ///
    /// 반환 `false` 는 name/payload 에 내부 NUL 이 있어 CString 변환에 실패해
    /// 이벤트가 소실되었다는 뜻이다(호출자가 로그로 처리). 해제 경합으로
    /// 콜백을 실행하지 못한 stale snapshot 의 경우 `true` 를 반환하는데, 이는
    /// "콘텐츠 문제로 소실"과 구분되며 상위 버스-우회 계약(싱크가 설치되어
    /// 있었으므로 폴링 버스로도 전달하지 않음)에는 그대로 부합한다.
    fn invoke(&self, name: &str, payload: &str) -> bool {
        {
            let mut activity = self
                .0
                .activity
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !activity.enabled {
                return true; // 해제와 경합한 stale EventSink snapshot — 조용히 폐기
            }
            activity.active_calls += 1;
        }
        let _active = FfiEventCallGuard(&self.0);
        let Ok(name_c) = std::ffi::CString::new(name) else {
            return false;
        };
        let Ok(payload_c) = std::ffi::CString::new(payload) else {
            return false;
        };
        unsafe { (self.0.callback)(self.0.user_data, name_c.as_ptr(), payload_c.as_ptr()) };
        true
    }

    /// 새 호출을 차단하고 이미 시작한 콜백이 모두 반환할 때까지 기다린다.
    fn deactivate_and_wait(&self) {
        let mut activity = self
            .0
            .activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        activity.enabled = false;
        while activity.active_calls != 0 {
            activity = self
                .0
                .quiescent
                .wait(activity)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
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
/// 해제/교체 등록은 진행 중인 콜백이 모두 반환할 때까지 기다린다. 함수가
/// 반환되면 구 `user_data`는 더 이상 호출되지 않으므로 호스트가 안전하게
/// 해제할 수 있다. 콜백 자신 안에서 동기 unregister/register를 호출하면 자기
/// 완료를 기다리는 교착이므로 금지한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_event_sink_register(
    callback: FfiEventCallback,
    user_data: *mut c_void,
) {
    // catch_unwind: 전역 락이 이미 포이즈닝된 경우에도 등록 경로가 UB 를
    // 만들지 않게 한다(패닉은 stderr 로그만 남긴다).
    let _ = std::panic::catch_unwind(|| {
        let new_sink = FfiEventSink::new(callback, user_data);
        let mut guard = match FFI_EVENT_SINK.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        let previous = guard.replace(new_sink.clone());

        // 전역 패키지가 이미 등록되어 있으면 Rust 싱크를 설치한다. 미등록이면
        // 나중에 register_ffi() 가 호출될 때 install_pending_ffi_event_sink 가
        // 설치를 이어간다(지연 설치).
        if let Some(pkg) = get_package() {
            pkg.set_event_sink(Some(rust_event_sink(new_sink)));
        }
        drop(guard);
        if let Some(previous) = previous {
            previous.deactivate_and_wait();
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
        let previous = guard.take();
        if let Some(pkg) = get_package() {
            pkg.set_event_sink(None);
        }
        drop(guard);
        if let Some(previous) = previous {
            previous.deactivate_and_wait();
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
        // 전역 registry lock을 유지한 채 Package sink를 갱신해 unregister가
        // pending snapshot 이후 끼어들어 stale sink를 다시 설치하는 TOCTOU를
        // 막는다. emit 경로는 이 전역 lock을 읽지 않는다.
        let guard = match FFI_EVENT_SINK.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if let Some(sink) = guard.as_ref() {
            self.set_event_sink(Some(rust_event_sink(sink.clone())));
        }
    }
}

// ── 채널 FFI (타입 패리티 2단계 — Tauri ipc::Channel 모델) ──────────────
// 호스트(C++ JSI 등)가 채널 핸들을 발급/해제하고, Rust 커맨드 핸들러가
// `rustra_ffi_channel_send` 로 호출 귀속 역방향 스트림을 흘린다.
// 이벤트 싱크(브로드캐스트)와 달리 채널은 유니캐스트 회신이다 —
// crates/rustra/src/channels.rs 의 계약 문서 참고.

/// 호스트 채널 수신 콜백 — `rustra_ffi_channel_create` 로 등록한다.
///
/// `handle` 는 발급 시 부여된 채널 번호(호스트가 핸들별 JS 콜백을 찾는 키),
/// `payload` 는 NUL 종결 C 문자열(JSON — 이벤트 싱크와 동일 인코딩).
/// 채널은 C-unwind 가 아니라 C ABI 다: `channels::ChannelHost::send` 가
/// 콜백 패닉을 잡아 무시하므로 호스트 콜백은 unwind 하지 않아도 된다.
pub type FfiChannelCallback =
    unsafe extern "C" fn(user_data: *mut c_void, handle: u32, payload: *const c_char);

/// FFI 채널 콜백 래퍼 — `FfiEventSink` 와 동일한 quiescence 계약으로
/// drop 반환 뒤에는 host `user_data`를 참조하는 콜백이 남지 않게 한다.
struct FfiChannelSinkInner {
    callback: FfiChannelCallback,
    handle: u32,
    #[allow(clippy::trivially_copy_pass_by_ref)]
    user_data: *mut c_void,
    activity: Mutex<FfiEventActivity>,
    quiescent: std::sync::Condvar,
}

#[derive(Clone)]
struct FfiChannelSink(std::sync::Arc<FfiChannelSinkInner>);

unsafe impl Send for FfiChannelSinkInner {}
unsafe impl Sync for FfiChannelSinkInner {}

struct FfiChannelCallGuard<'a>(&'a FfiChannelSinkInner);

impl Drop for FfiChannelCallGuard<'_> {
    fn drop(&mut self) {
        let mut activity = self
            .0
            .activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        activity.active_calls = activity.active_calls.saturating_sub(1);
        if activity.active_calls == 0 {
            self.0.quiescent.notify_all();
        }
    }
}

impl FfiChannelSink {
    fn new(callback: FfiChannelCallback, handle: u32, user_data: *mut c_void) -> Self {
        Self(std::sync::Arc::new(FfiChannelSinkInner {
            callback,
            handle,
            user_data,
            activity: Mutex::new(FfiEventActivity {
                enabled: true,
                active_calls: 0,
            }),
            quiescent: std::sync::Condvar::new(),
        }))
    }

    fn invoke(&self, payload: &str) {
        {
            let mut activity = self
                .0
                .activity
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !activity.enabled {
                return;
            }
            activity.active_calls += 1;
        }
        let _active = FfiChannelCallGuard(&self.0);
        let Ok(payload_c) = std::ffi::CString::new(payload) else {
            return; // 내부 NUL — 이벤트 싱크와 동일하게 소실(로그 없음, 채널은 유니캐스트)
        };
        unsafe { (self.0.callback)(self.0.user_data, self.0.handle, payload_c.as_ptr()) };
    }

    fn deactivate_and_wait(&self) {
        let mut activity = self
            .0
            .activity
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        activity.enabled = false;
        while activity.active_calls != 0 {
            activity = self
                .0
                .quiescent
                .wait(activity)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
    }
}

static FFI_CHANNEL_SINKS: Mutex<std::collections::BTreeMap<u32, FfiChannelSink>> =
    Mutex::new(std::collections::BTreeMap::new());

/// 호스트 채널을 등록하고 새 핸들(≥1, 단조 증가)을 반환한다.
///
/// 커맨드 인자 `ChannelHandle(u32)` 로 이 값을 JS 에서 전달한다. 콜백의
/// 두 번째 인자로 이 핸들이 다시 전달되므로 호스트는 핸들→JS 콜백
/// 룩업만 하면 된다.
///
/// # Safety
///
/// `callback` 은 유효한 함수 포인터, `user_data` 는 호스트 소유다. 반환된
/// 핸들은 `rustra_ffi_channel_drop` 전까지 유효하며, drop은 이미 시작한 콜백이
/// 모두 반환할 때까지 기다린다. drop 반환 뒤 host가 `user_data`를 해제해도
/// 안전하다. 콜백 안에서 자기 핸들을 동기 drop하면 교착하므로 금지한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_channel_create(
    callback: FfiChannelCallback,
    user_data: *mut c_void,
) -> u32 {
    // 두 단계: 핸들 선발급 → 핸들을 캡처한 콜백 등록. register_channel 이
    // 핸들을 반환하므로 sink 생성 시점에 번호가 필요하다(선발급 후 insert).
    let host = crate::channels::host();
    let handle = host.reserve_handle();
    if handle == 0 {
        return 0;
    }
    let sink = FfiChannelSink::new(callback, handle, user_data);
    FFI_CHANNEL_SINKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .insert(handle, sink.clone());
    let sender: crate::channels::ChannelSender =
        std::sync::Arc::new(move |payload: &str| sink.invoke(payload));
    host.register_channel_with_handle(handle, sender);
    handle
}

/// 채널로 JSON 페이로드를 흘린다. 핸들이 유효하면 1(도달), 만료/미등록이면 0.
///
/// # Safety
///
/// `payload` 는 NUL 종결 문자열. 이 함수 자체는 안전하다(조용한 bool 반환).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_channel_send(handle: u32, payload: *const c_char) -> i32 {
    let payload = if payload.is_null() {
        String::new()
    } else {
        // Safety: caller guarantees NUL-terminated readable string.
        unsafe { std::ffi::CStr::from_ptr(payload) }
            .to_string_lossy()
            .into_owned()
    };
    i32::from(crate::channels::host().send(handle, &payload))
}

/// 채널을 해제한다(호출 완료/취소 시). 성공 해제면 1, 없으면 0. 이후
/// 동일 핸들 send 는 0 — 핸들 번호는 재사용되지 않는다.
///
/// # Safety
///
/// 이 함수 자체는 안전하다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_ffi_channel_drop(handle: u32) -> i32 {
    let host_removed = crate::channels::host().drop_channel(handle);
    let sink = FFI_CHANNEL_SINKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .remove(&handle);
    if let Some(sink) = sink.as_ref() {
        sink.deactivate_and_wait();
    }
    i32::from(host_removed || sink.is_some())
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

    /// 채널 FFI 왕복 — C ABI 콜백으로 등록한 핸들에 send 가 도달하고,
    /// drop 후에는 0(stale) 을 반환한다. 핸들 공간은 전역이므로 각 테스트가
    /// 서로 독립된 핸들을 쓴다(단조 증가 보장). 콜백 두 번째 인자(handle)로
    /// 발급 번호가 그대로 회신되는 것도 함께 검증한다.
    #[test]
    fn ffi_channel_round_trip() {
        use std::sync::Mutex;
        use std::sync::atomic::{AtomicU32, AtomicUsize, Ordering};

        static HITS: AtomicUsize = AtomicUsize::new(0);
        static SEEN: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());
        static GOT_HANDLE: AtomicU32 = AtomicU32::new(0);

        unsafe extern "C" fn cb(_ud: *mut c_void, handle: u32, payload: *const c_char) {
            HITS.fetch_add(1, Ordering::Relaxed);
            GOT_HANDLE.store(handle, Ordering::Relaxed);
            let s = unsafe { std::ffi::CStr::from_ptr(payload) }
                .to_string_lossy()
                .into_owned();
            SEEN.lock().unwrap().push((handle, s));
        }

        let handle = unsafe { rustra_ffi_channel_create(cb, std::ptr::null_mut()) };
        assert!(handle >= 1, "핸들은 1부터 단조 증가");

        let sent = unsafe {
            let c = std::ffi::CString::new(r#"{"step":1,"of":2}"#).unwrap();
            rustra_ffi_channel_send(handle, c.as_ptr())
        };
        assert_eq!(sent, 1);
        assert_eq!(HITS.load(Ordering::Relaxed), 1);
        // 콜백 회신 handle == 발급 handle — 호스트가 핸들→JS 콜백 룩업의 키.
        assert_eq!(GOT_HANDLE.load(Ordering::Relaxed), handle);
        assert_eq!(SEEN.lock().unwrap()[0].1, r#"{"step":1,"of":2}"#);

        // drop 후 stale send 는 0 — 콜백 미도달.
        assert_eq!(unsafe { rustra_ffi_channel_drop(handle) }, 1);
        let stale = unsafe {
            let c = std::ffi::CString::new("x").unwrap();
            rustra_ffi_channel_send(handle, c.as_ptr())
        };
        assert_eq!(stale, 0);
        assert_eq!(HITS.load(Ordering::Relaxed), 1, "stale send 는 콜백 미도달");
        // double drop 은 0.
        assert_eq!(unsafe { rustra_ffi_channel_drop(handle) }, 0);
    }

    struct SlowChannelCallback {
        entered: std::sync::Barrier,
        release: std::sync::Barrier,
    }

    unsafe extern "C" fn slow_channel_cb(
        user_data: *mut c_void,
        _handle: u32,
        _payload: *const c_char,
    ) {
        let state = unsafe { &*(user_data as *const SlowChannelCallback) };
        state.entered.wait();
        state.release.wait();
    }

    #[test]
    fn ffi_channel_drop_waits_until_user_data_is_quiescent() {
        let state = std::sync::Arc::new(SlowChannelCallback {
            entered: std::sync::Barrier::new(2),
            release: std::sync::Barrier::new(2),
        });
        let handle = unsafe {
            rustra_ffi_channel_create(
                slow_channel_cb,
                std::sync::Arc::as_ptr(&state) as *mut c_void,
            )
        };
        let send = std::thread::spawn(move || unsafe {
            let payload = std::ffi::CString::new("slow").unwrap();
            rustra_ffi_channel_send(handle, payload.as_ptr())
        });
        state.entered.wait();

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let dropper = std::thread::spawn(move || {
            let dropped = unsafe { rustra_ffi_channel_drop(handle) };
            done_tx.send(dropped).unwrap();
        });
        assert!(
            done_rx
                .recv_timeout(std::time::Duration::from_millis(25))
                .is_err(),
            "drop must wait while callback still owns user_data",
        );

        state.release.wait();
        assert_eq!(
            done_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .expect("drop must finish after callback returns"),
            1,
        );
        assert_eq!(send.join().unwrap(), 1);
        dropper.join().unwrap();
        drop(state);
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
    // 전역 FFI_CONTEXT / FFI_EVENT_SINK 을 공유하므로 병렬 테스트 간 간섭이 생긴다
    // (FFI_CONTEXT.set 은 첫 등록만 유효 — 이후 테스트의 패키지는 전역에 반영되지
    // 않는다). 따라서 상태 전이 전체(등록 → emit 수신 → 해제 → 폴링 복귀)를
    // 하나의 순차 테스트로 완결하고, 전역 락으로 다른 sink 테스트와 상호배제한다.

    /// 전역 FFI_CONTEXT 가 이미 등록되어 있으면 그것을, 아니면 지금 등록한다.
    /// (register_ffi 는 idempotent — 첫 호출이 이긴다.)
    fn ensure_global_package() -> Package {
        let pkg = test_package();
        pkg.register_ffi();
        get_package().expect("package must be registered").clone()
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

    struct SlowEventCallback {
        entered: std::sync::Barrier,
        release: std::sync::Barrier,
    }

    unsafe extern "C-unwind" fn slow_event_cb(
        user_data: *mut c_void,
        _name: *const c_char,
        _payload: *const c_char,
    ) {
        let state = unsafe { &*(user_data as *const SlowEventCallback) };
        state.entered.wait();
        state.release.wait();
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
    fn ffi_event_sink_unregister_waits_until_user_data_is_quiescent() {
        let _guard = SINK_TEST_MUTEX.lock().unwrap();
        let pkg = ensure_global_package();
        let state = std::sync::Arc::new(SlowEventCallback {
            entered: std::sync::Barrier::new(2),
            release: std::sync::Barrier::new(2),
        });
        unsafe {
            rustra_ffi_event_sink_register(
                slow_event_cb,
                std::sync::Arc::as_ptr(&state) as *mut c_void,
            )
        };

        let emit_pkg = pkg.clone();
        let emit = std::thread::spawn(move || emit_pkg.emit("slow", serde_json::json!({})));
        state.entered.wait();

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let unregister = std::thread::spawn(move || {
            unsafe { rustra_ffi_event_sink_unregister() };
            done_tx.send(()).unwrap();
        });
        assert!(
            done_rx
                .recv_timeout(std::time::Duration::from_millis(25))
                .is_err(),
            "unregister must not return while callback still owns user_data",
        );

        state.release.wait();
        done_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("unregister must finish after callback returns");
        emit.join().unwrap();
        unregister.join().unwrap();
        // unregister 반환 뒤 Arc를 즉시 drop해도 더 이상 callback이 없다.
        drop(state);
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
        // (전역 FFI_CONTEXT 는 다른 테스트가 이미 등록했을 수 있다 — 어느 쪽이든
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

    // ── run_worker 취소 체크포인트 (경합 없는 결정적 검증) ──────
    //
    // FFI async 엔트리는 워커 스레드 스케줄링 경합 때문에 "cancel 먼저" 순서를
    // 강제할 수 없다. 대신 run_worker 를 직접 호출해 레지스트리가 이미
    // Cancelled 인 경우를 결정적으로 검증한다: invoke_fn 은 절대 실행되지
    // 않아야 하고, on_complete 로는 cancelled 에러 프레임이 전달되어야 한다.

    /// 더미 invoke_fn — 실행됐다면 플래그를 올린다 (절대 false 여야 함).
    static WORKER_INVOKE_RAN: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);

    unsafe extern "C" fn sentinel_invoke(
        _payload: *const u8,
        _len: usize,
        _out_len: *mut usize,
    ) -> *mut u8 {
        WORKER_INVOKE_RAN.store(true, std::sync::atomic::Ordering::SeqCst);
        std::ptr::null_mut()
    }

    /// on_complete 로 전달된 버퍼를 Vec 으로 캡처한다. null 버퍼로 호출된
    /// 경우에도 콜백 자체는 발생했음을 플래그로 기록한다.
    static WORKER_FRAME: Mutex<Option<(Vec<u8>, usize)>> = Mutex::new(None);
    static WORKER_CB_FIRED: std::sync::atomic::AtomicBool =
        std::sync::atomic::AtomicBool::new(false);

    unsafe extern "C" fn capture_frame_cb(_user: *mut c_void, ptr: *mut u8, len: usize) {
        WORKER_CB_FIRED.store(true, std::sync::atomic::Ordering::SeqCst);
        if ptr.is_null() {
            return;
        }
        let data = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
        unsafe { rustra_ffi_free(ptr, len) };
        *WORKER_FRAME.lock().unwrap() = Some((data, len));
    }

    /// run_worker 테스트 간 상호배제 — 플래그/프레임 셀이 공유 static 이므로
    /// 병렬 실행 시 서로의 상태를 덮어쓴다 (SINK_TEST_MUTEX 와 같은 패턴).
    static WORKER_TEST_MUTEX: Mutex<()> = Mutex::new(());

    #[test]
    fn run_worker_pre_cancelled_skips_invoke_and_returns_cancelled_frame() {
        let _guard = WORKER_TEST_MUTEX.lock().unwrap();
        let id = crate::cancel::register_invocation();
        assert!(crate::cancel::cancel_invocation(id));

        WORKER_INVOKE_RAN.store(false, std::sync::atomic::Ordering::SeqCst);
        WORKER_FRAME.lock().unwrap().take();

        run_worker(
            id,
            Vec::new(),
            0,
            Some(capture_frame_cb),
            sentinel_invoke,
            json_serialize,
        );

        assert!(
            !WORKER_INVOKE_RAN.load(std::sync::atomic::Ordering::SeqCst),
            "pre-cancelled invocation must never start the handler"
        );
        let (frame, len) = WORKER_FRAME
            .lock()
            .unwrap()
            .take()
            .expect("on_complete must deliver the cancelled frame");
        let resp: FfiResponse = serde_json::from_slice(&frame).unwrap();
        assert!(!resp.ok);
        assert_eq!(resp.result, None);
        assert_eq!(
            resp.error.as_deref(),
            Some("cancelled: invocation cancelled before dispatch"),
            "cancelled frame must carry the stable `cancelled: ` prefix"
        );
        assert_eq!(frame.len(), len);
        assert_eq!(
            crate::cancel::status(id),
            crate::cancel::Status::Unknown,
            "complete_invocation must clear the registry entry"
        );
    }

    #[test]
    fn run_worker_running_invocation_dispatches_normally() {
        let _guard = WORKER_TEST_MUTEX.lock().unwrap();
        let id = crate::cancel::register_invocation();

        WORKER_INVOKE_RAN.store(false, std::sync::atomic::Ordering::SeqCst);
        WORKER_FRAME.lock().unwrap().take();
        WORKER_CB_FIRED.store(false, std::sync::atomic::Ordering::SeqCst);

        run_worker(
            id,
            Vec::new(),
            0,
            Some(capture_frame_cb),
            sentinel_invoke,
            json_serialize,
        );

        assert!(
            WORKER_INVOKE_RAN.load(std::sync::atomic::Ordering::SeqCst),
            "running invocation must reach the handler"
        );
        // WORKER_FRAME.is_none() 만으로는 "콜백이 null 버퍼로 호출됨"과
        // "아예 호출 안 됨"을 구분할 수 없다 — 플래그로 실제 발생을 증명한다.
        assert!(
            WORKER_CB_FIRED.load(std::sync::atomic::Ordering::SeqCst),
            "sentinel returns null → on_complete must still fire (with a null buffer)"
        );
        assert!(
            WORKER_FRAME.lock().unwrap().is_none(),
            "null buffer must not be captured as a frame"
        );
        assert_eq!(crate::cancel::status(id), crate::cancel::Status::Unknown);
    }
}
