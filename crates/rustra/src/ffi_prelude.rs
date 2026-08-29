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

/// 현재 페이로드 크기 한도 (invoke 경로의 크기 가드가 읽는 단일 지점).
///
/// 공개 판독기(구현 완료) — `Package::invoke_rkyv_v2` 등 FFI 엔트리가 직접
/// 노출하지 않는 경로(rkyv V2 와이어)도 동일한 동적 한도를 읽어 게이트한다.
/// `rustra_ffi_get_max_payload` FFI 심볼과 같은 값을 반환한다.
pub fn max_payload_bytes() -> usize {
    crate::limits::max_payload_bytes()
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
