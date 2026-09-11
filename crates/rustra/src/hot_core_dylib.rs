// ── dylib 코어 결합 (experimental, hot-core feature) ─────────────────────────
//
// cdylib 을 열고 코어 C ABI(blob, with_panic_guard)로 묶는 층. 상위 파사드는
// `hot_core.rs` — 공개 경로는 `rustra::hot_core::*` re-export 가 고정한다.
//
// # dlclose 금지 (제약)
//
// [`DylibCore`] 는 [`libloading::Library`] 를 절대 drop 하지 않는다. macOS는
// std TLS 때문에 dlclose 언로드 자체가 no-op이고(libloading #59, dyld man 3),
// Linux는 dlclose가 실제 언로드를 일으켜 스왑 전부터 살아있던 구 심볼
// 포인터가 use-after-unload 된다. 세션당 버전 카피 1개씩의 매핑 누수는 dev
// 환경 감수 정책이므로 open 시점에 `Box::leak` 으로 `'static` 고정한다 —
// swap 으로 밀려난 구 코어가 드랍돼도 dlclose 가 일어나지 않는다.

use super::JsonDispatch;
use serde_json::{Value, json};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

// -- 코어 C ABI 원형 ----------------------------------------------------------

/// `rustra_ffi_invoke_json` — blob C ABI. 요청은
/// `{"command":"...","args":...}` 원시 바이트, 응답은
/// `{"ok":bool,"result":...,"error":"..."}` 원시 바이트.
type InvokeJsonFn = unsafe extern "C" fn(*const u8, usize, *mut usize) -> *mut u8;
/// `rustra_ffi_contract_hash` — 계약 해시(SHA-256 hex)를 UTF-8 blob 으로.
type ContractHashFn = unsafe extern "C" fn(*mut usize) -> *mut u8;
/// `rustra_ffi_free` — 받은 (ptr, len) 쌍 그대로 호출해야 한다.
type FreeFn = unsafe extern "C" fn(*mut u8, usize);
/// `rustra_mobile_init` — cdylib 전역 패키지 등록 엔트리.
type MobileInitFn = unsafe extern "C" fn();

/// 열린 cdylib 코어 — 바인딩된 심볼과 leak된 라이브러리 매핑을 소유한다.
///
/// leak 계약은 모듈 헤더의 dlclose 금지 주석 참고.
pub struct DylibCore {
    #[allow(dead_code)]
    library: &'static libloading::Library,
    invoke_json_fn: InvokeJsonFn,
    contract_hash_fn: ContractHashFn,
    free_fn: FreeFn,
}

// 참고: Library/Symbol 이 아닌 생 함수 포인터만 보관한다 — Symbol 은 Library
// 차용을 동반해 자기참조 구조가 되는데, leak된 &'static Library 덕에 포인터만
// 남겨도 수명이 성립한다.

/// `hot-core` 표면의 오류. 표시 형태는 `hot-core: <상황>: <상세>` 다.
#[derive(Debug)]
pub enum DylibCoreError {
    /// dlopen 실패 — 파일 부재, 아키텍처 불일치, 서명 검증 거부 등.
    Open { path: PathBuf, source: String },
    /// 필수 심볼 바인딩 실패 — rustra FFI 표면이 없는 공유 라이브러리.
    Symbol {
        symbol: &'static str,
        source: String,
    },
    /// 계약 해시 조회/디코드 실패.
    ContractHash { message: String },
    /// dylib 디스패치 왕복 자체의 실패(null 응답, 응답 디코드 실패).
    Dispatch { message: String },
    /// 스왑 카피 생성 실패.
    Prepare { path: PathBuf, message: String },
    /// macOS ad-hoc 재서명 실패 — loud 에러로 전파한다(조용한 스킵 없음).
    Codesign { path: PathBuf, message: String },
    /// open/swap 경로에서 걸러낸 패닉 — 감시 스레드와 호스트를 살려둔다.
    Panic { message: String },
}

impl fmt::Display for DylibCoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DylibCoreError::Open { path, source } => write!(
                formatter,
                "hot-core: dylib open failed for {}: {source}",
                path.display()
            ),
            DylibCoreError::Symbol { symbol, source } => {
                write!(
                    formatter,
                    "hot-core: symbol binding failed for {symbol}: {source}"
                )
            }
            DylibCoreError::ContractHash { message } => {
                write!(formatter, "hot-core: contract hash unavailable: {message}")
            }
            DylibCoreError::Dispatch { message } => {
                write!(formatter, "hot-core: dylib dispatch failed: {message}")
            }
            DylibCoreError::Prepare { path, message } => write!(
                formatter,
                "hot-core: swap copy preparation failed for {}: {message}",
                path.display()
            ),
            DylibCoreError::Codesign { path, message } => write!(
                formatter,
                "hot-core: codesign failed for {}: {message}",
                path.display()
            ),
            DylibCoreError::Panic { message } => {
                write!(formatter, "hot-core: panic while swapping: {message}")
            }
        }
    }
}

impl std::error::Error for DylibCoreError {}

impl DylibCore {
    /// cdylib 을 열고 Bun 어댑터와 동일한 초기화 시퀀스를 밟는다:
    /// dlopen → 심볼 바인딩 → `rustra_mobile_init()` 호출.
    ///
    /// `rustra_mobile_init` 은 코어 내부의 전역 FFI 컨텍스트(`register_ffi`,
    /// OnceLock first-wins)에 패키지를 등록한다 — 이후 `invoke_json` /
    /// `contract_hash` 가 그 전역 상태를 읽는다. idempotent 하다(등록은
    /// first-wins, 패키지 생성은 OnceLock).
    pub fn open(artifact: &Path) -> Result<Self, DylibCoreError> {
        let library =
            unsafe { libloading::Library::new(artifact) }.map_err(|e| DylibCoreError::Open {
                path: artifact.to_path_buf(),
                source: e.to_string(),
            })?;
        // dlclose 금지 — 모듈 헤더의 제약 주석 참고. leak은 의도다.
        let library: &'static libloading::Library = Box::leak(Box::new(library));
        let mobile_init: MobileInitFn = bind_symbol(library, "rustra_mobile_init")?;
        let invoke_json_fn: InvokeJsonFn = bind_symbol(library, "rustra_ffi_invoke_json")?;
        let contract_hash_fn: ContractHashFn = bind_symbol(library, "rustra_ffi_contract_hash")?;
        let free_fn: FreeFn = bind_symbol(library, "rustra_ffi_free")?;
        // Bun 어댑터(bun-ffi.ts)와 동일 — dlopen 직후 init 엔트리를 호출한다.
        // Apple/Linux 빌드는 로드 시점 constructor 로도 같은 일을 하지만,
        // constructor 부재 플랫폼(Windows 등)과 명시 호출 순서의 단일성을 위해
        // 항상 여기서 호출한다(호출은 멱등).
        unsafe { mobile_init() };
        Ok(Self {
            library,
            invoke_json_fn,
            contract_hash_fn,
            free_fn,
        })
    }

    /// 코어의 JSON 디스패치 엔트리로 명령 하나를 실행한다.
    ///
    /// 실패 값은 코어가 돌려준 FfiResponse.error 문자열을
    /// `{code, message}` 로 재분할한 객체다 — 분할 규칙은 코어
    /// `frame_error_bytes` 와 동일(첫 `": "` 기준, 없으면 `invoke.failed`).
    pub fn invoke_json(&self, command: &str, args: Value) -> Result<Value, Value> {
        let envelope = json!({"command": command, "args": args});
        let payload = serde_json::to_vec(&envelope).map_err(
            |e| json!({"code": "invoke.failed", "message": format!("request encode failed: {e}")}),
        )?;
        let mut out_len: usize = 0;
        // Safety: payload 는 payload.len() 바이트 유효, out_len 은 유효 쓰기
        // 포인터다. 응답 버퍼 규약은 코어 FFI와 동일 — 받은 (ptr, len) 쌍을
        // 그대로 rustra_ffi_free 로 해제한다(debug 빌드 free_guard 가
        // 오남용 시 abort 하므로 정확한 쌍 전달이 계약).
        let ptr = unsafe { (self.invoke_json_fn)(payload.as_ptr(), payload.len(), &mut out_len) };
        if ptr.is_null() {
            return Err(json!({
                "code": "invoke.failed",
                "message": "dylib dispatch returned a null response"
            }));
        }
        // Safety: 코어 FFI 계약상 ptr 은 out_len 바이트의 읽기 유효 버퍼다.
        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
        // Safety: 반환된 (ptr, len) 쌍 그대로 1회 해제.
        unsafe { (self.free_fn)(ptr, out_len) };

        let response: Value = serde_json::from_slice(&bytes).map_err(|e| {
            json!({
                "code": "invoke.failed",
                "message": format!("dylib response decode failed: {e}")
            })
        })?;
        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(response.get("result").cloned().unwrap_or(Value::Null))
        } else {
            let raw = response
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("unknown dylib error");
            Err(split_error_wire(raw))
        }
    }

    /// 코어에 등록된 패키지의 계약 해시 (SHA-256 hex, 64자).
    pub fn contract_hash(&self) -> Result<String, DylibCoreError> {
        let mut out_len: usize = 0;
        // Safety: out_len 은 유효 쓰기 포인터.
        let ptr = unsafe { (self.contract_hash_fn)(&mut out_len) };
        if ptr.is_null() {
            return Err(DylibCoreError::ContractHash {
                message: "dylib returned a null response".into(),
            });
        }
        // Safety: 코어 FFI 계약상 ptr 은 out_len 바이트 읽기 유효.
        let bytes = unsafe { std::slice::from_raw_parts(ptr, out_len) }.to_vec();
        // Safety: 반환된 (ptr, len) 쌍 그대로 1회 해제.
        unsafe { (self.free_fn)(ptr, out_len) };
        String::from_utf8(bytes).map_err(|e| DylibCoreError::ContractHash {
            message: format!("contract hash is not UTF-8: {e}"),
        })
    }
}

fn bind_symbol<T: Copy + 'static>(
    library: &'static libloading::Library,
    symbol: &'static str,
) -> Result<T, DylibCoreError> {
    let mut name = symbol.to_string();
    name.push('\0');
    let bound: libloading::Symbol<'static, T> =
        unsafe { library.get(name.as_bytes()) }.map_err(|e| DylibCoreError::Symbol {
            symbol,
            source: e.to_string(),
        })?;
    Ok(*bound)
}

/// FfiResponse.error 표시 문자열(`"code: message"`)을 에러 와이어 객체로
/// 재분할한다 — 코어 `frame_error_bytes` 의 재구성 규칙과 동일하다.
fn split_error_wire(raw: &str) -> Value {
    match raw.split_once(": ") {
        Some((code, message)) => json!({"code": code, "message": message}),
        None => json!({"code": "invoke.failed", "message": raw}),
    }
}

/// Arc 공유 가능한 스왑 지점 — 내부 `RwLock<DylibCore>` 를 교체하며
/// [`JsonDispatch`] 로 디스패치를 위임한다. read lock 으로 invoke,
/// write lock 으로 swap — invoke 중인 호출은 끝날 때까지 swap 을 막고,
/// 새 호출은 스왑 뒤 코어로 향한다.
pub struct HotCoreHandle {
    core: RwLock<DylibCore>,
}

impl HotCoreHandle {
    pub fn new(core: DylibCore) -> Self {
        Self {
            core: RwLock::new(core),
        }
    }

    /// 현재 코어를 `new` 로 교체하고 구 코어를 돌려준다.
    ///
    /// 돌려진 구 코어는 계속 호출 가능하다 — Library leak 계약상 swap 이
    /// dlclose 를 일으키지 않기 때문이다(모듈 헤더 주석 참고).
    pub fn swap(&self, new: DylibCore) -> DylibCore {
        let mut guard = self
            .core
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        std::mem::replace(&mut *guard, new)
    }

    /// 현재 코어의 계약 해시 — 스왑 보고(old vs new)에 쓴다.
    pub fn contract_hash(&self) -> Result<String, DylibCoreError> {
        self.core
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .contract_hash()
    }
}

impl JsonDispatch for HotCoreHandle {
    fn invoke_json(&self, command: &str, args: Value) -> Result<Value, Value> {
        let guard = self
            .core
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.invoke_json(command, args)
    }
}

/// 아티팩트를 같은 디렉터리의 `<stem>-hot-<counter><ext>` 로 복사한다.
///
/// # 버전 카피가 필요한 제약
///
/// 같은 경로를 다시 dlopen 하면 dyld/bionic 캐시가 히트해 **구 매핑**을
/// 돌려준다(libloading #59) — 새 바이트를 담으려면 경로 자체가 달라야 한다.
/// 카운터는 단조 증가해 세션 내 경로 재사용이 없다.
///
/// macOS에서는 복사 뒤 `codesign --force --sign -` ad-hoc 재서명을 한다 —
/// cargo 산출물은 linker-signed 라 단순 카피는 서명 불일치로 열리지 않을 수
/// 있다(hot-lib-reloader #15). 재서명 실패는 loud 에러로 전파한다.
pub fn prepare_swap_copy(artifact: &Path, counter: u64) -> Result<PathBuf, DylibCoreError> {
    let stem = artifact
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| DylibCoreError::Prepare {
            path: artifact.to_path_buf(),
            message: "artifact file name is not valid UTF-8".into(),
        })?;
    let copy_name = match artifact.extension() {
        Some(ext) => format!("{stem}-hot-{counter}.{}", ext.to_string_lossy()),
        None => format!("{stem}-hot-{counter}"),
    };
    let copy_path = artifact.with_file_name(copy_name);
    std::fs::copy(artifact, &copy_path).map_err(|e| DylibCoreError::Prepare {
        path: copy_path.clone(),
        message: format!("copy failed: {e}"),
    })?;
    #[cfg(target_os = "macos")]
    ad_hoc_codesign(&copy_path)?;
    Ok(copy_path)
}

#[cfg(target_os = "macos")]
fn ad_hoc_codesign(copy: &Path) -> Result<(), DylibCoreError> {
    let output = std::process::Command::new("codesign")
        .args(["--force", "--sign", "-"])
        .arg(copy)
        .output()
        .map_err(|e| DylibCoreError::Codesign {
            path: copy.to_path_buf(),
            message: format!("codesign spawn failed: {e}"),
        })?;
    if !output.status.success() {
        return Err(DylibCoreError::Codesign {
            path: copy.to_path_buf(),
            message: format!(
                "exit status {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        });
    }
    Ok(())
}
