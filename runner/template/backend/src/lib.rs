//! rustra runner 템플릿 — 단일 Rust 백엔드 (4플랫폼 공유).
//!
//! 이 crate 가 하는 일:
//! 1. `#[command]` 비즈니스 로직 (아래 `greet`). — 플랫폼 중립.
//! 2. `template_package()` 로 command 들을 rustra 패키지로 묶어 FFI 등록.
//! 3. rkyv V2 fast-path FFI 심볼(`rustra_template_invoke_rkyv_v2`) 노출 —
//!    모든 플랫폼 셸(Desktop host / iOS RustraModule / Android RustraModule)이 동일 심볼 호출.
//! 4. capability 추상(`capabilities.rs`) — 플랫폼 디바이스 API 접근.
//!
//! wire format (스파이크 7/7 로 증명된 rkyv V2):
//!   request  [cmd_id: u16 LE][postcard Input]
//!   response [ok: u8][7B pad][postcard Output]  또는 [ok=0][pad][err]
//!
//! `create-runner.sh my-app` 이 `template`/`rustra_template_` 식별자를 치환한다.

pub mod capabilities;

use rustra::ffi::FfiFormat;
use rustra::prelude::*;

// ── command: greet ──────────────────────────────────────────────────────────

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

/// 샘플 command. 새 command 추가 = Input/Output 구조체 + `#[command]` fn + `template_package()` 에 등록.
#[command]
pub fn greet(input: GreetInput) -> Result<GreetOutput> {
    Ok(GreetOutput {
        message: format!("Hello, {}!", input.name),
    })
}

// ── capability command (계층 B 실사용 예 — 플랫폼이 registry 를 주입해야 동작) ─

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ReadConfigInput {}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadConfigOutput {
    pub content: String,
}

/// 파일 읽기 capability. Desktop=std::fs, iOS=NSBundle, Android=assets.
/// registry 미주입 시 `capability.missing` (deny-by-default 와 동일 철학).
#[command]
pub fn read_config(_input: ReadConfigInput) -> Result<ReadConfigOutput> {
    let cap = capabilities::registry()
        .and_then(|r| r.file())
        .ok_or_else(|| RustraError::custom("capability.missing", "file capability not provided"))?;
    let bytes = cap
        .read_file("config.json")
        .map_err(|e| RustraError::custom("io", e))?;
    let content =
        String::from_utf8(bytes).map_err(|e| RustraError::custom("encoding", e.to_string()))?;
    Ok(ReadConfigOutput { content })
}

#[derive(Debug, Serialize, Deserialize, JsonSchema, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NotifyInput {
    pub title: String,
    pub body: String,
}

/// 알림 capability. Desktop=셸 plugin, iOS=UNUserNotificationCenter, Android=NotificationManagerCompat.
#[command]
pub fn notify(input: NotifyInput) -> Result<()> {
    let cap = capabilities::registry()
        .and_then(|r| r.notify())
        .ok_or_else(|| {
            RustraError::custom("capability.missing", "notify capability not provided")
        })?;
    cap.notify(&input.title, &input.body)
        .map_err(|e| RustraError::custom("notify", e))
}

// ── 패키지 등록 ─────────────────────────────────────────────────────────────

static CACHED_PACKAGE: std::sync::OnceLock<Package> = std::sync::OnceLock::new();

/// rustra 패키지 — 모든 command 를 묶어 FFI(rkyv V2 + JSON)로 노출.
pub fn template_package() -> Package {
    CACHED_PACKAGE
        .get_or_init(|| {
            let pkg =
                register!(Package::builder("template.app"), greet, read_config, notify).build();
            pkg.register_ffi_with_default(FfiFormat::Json);
            pkg
        })
        .clone()
}

/// C 진입점: 패키지를 FFI 용으로 idempotent 등록.
/// Apple 은 `__mod_init_func` 가 자동 등록하지만 Windows(PE)/Android(ELF) 는 명시 호출 필수.
/// 각 플랫폼 셸 로드 시점(desktop lynx_spike_init / iOS JSI install / Android JNI_OnLoad)이 호출.
#[unsafe(no_mangle)]
pub extern "C" fn rustra_template_init() {
    let _ = template_package();
}

// ── rkyv V2 fast-path FFI ───────────────────────────────────────────────────
// 모든 플랫폼 셸이 이 심볼을 호출한다:
//   desktop: lynx_host.{mm,cpp} InvokeRkyvV2 N-API
//   iOS:     RustraModule.m invokeRkyvV2:
//   android: RustraModule.kt nativeInvokeRkyvV2(ByteArray) → JNI

/// # Safety
/// `payload` 는 `payload_len` 바이트 유효, `out_len` 은 유효한 포인터여야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_template_invoke_rkyv_v2(
    payload: *const u8,
    payload_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if payload.is_null() || out_len.is_null() {
        return std::ptr::null_mut();
    }
    let bytes = unsafe { std::slice::from_raw_parts(payload, payload_len) };
    let resp_bytes = match rustra::ffi::get_package()
        .ok_or_else(|| RustraError::custom("ffi.not_registered", "package not registered"))
        .and_then(|pkg| pkg.invoke_rkyv_v2(bytes))
    {
        Ok(bytes) => bytes,
        Err(error) => rustra::encode_rkyv_v2_error(&error),
    };
    alloc_response(resp_bytes, out_len)
}

/// # Safety
/// `ptr` 는 이전 invoke 호출이 반환한 포인터, `len` 은 그 때의 출력 길이와 일치해야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_template_free_buffer(ptr: *mut u8, len: usize) {
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
