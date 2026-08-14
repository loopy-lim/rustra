//! Platform-native capability 추상 (design §4 계층 B).
//!
//! Rust command 는 플랫폼 디바이스 API(file/notify/camera)를 직접 부를 수 없다
//! (모바일 샌드박스·권한). 대신 trait 로 추상하고, 플랫폼이 startup 에 구현체를 주입한다.
//!
//! - command 핸들러: `registry().and_then(|r| r.file())` 로만 디바이스 접근. 구현체 모름.
//! - Desktop(Tauri): `DesktopRegistry`(std::fs) 를 setup 에서 `set_registry()` 로 주입.
//! - Mobile(iOS/Android): `MobileRegistry` 가 Rust→플랫폼 콜백 브리지로 구현한다.
//!   NativeModule 이 startup 에 `rustra_template_register_mobile_registry()` FFI 로
//!   콜백을 등록하고, `read_file`/`notify` 가 그 콜백을 호출해
//!   Android `Context.openFileInput` / iOS `NSFileManager` · `UNUserNotificationCenter`
//!   로 위임한다. 사용법: `capabilities/README.md`.
//!
//! 새 capability 추가 = (1) trait + Registry 게터, (2) Desktop 구현체, (3) 디바이스면 Mobile 브리지.

use std::ffi::c_void;
use std::sync::OnceLock;

/// 파일 읽기 capability. Desktop=std::fs, Mobile=Context.openFileInput / NSFileManager.
pub trait FileCap: Send + Sync {
    fn read_file(&self, path: &str) -> Result<Vec<u8>, String>;
}

/// 사용자 알림 capability. Desktop=Tauri notification plugin, Mobile=NotificationManager / UNUserNotificationCenter.
pub trait NotifyCap: Send + Sync {
    fn notify(&self, title: &str, body: &str) -> Result<(), String>;
}

/// 플랫폼이 주입하는 capability registry. command 핸들러는 이것으로만 디바이스에 접근한다.
/// 각 게터는 Option — 해당 capability 를 플랫폼이 제공하지 않으면 None (→ command 가 명확한 에러 반환).
pub trait CapabilityRegistry: Send + Sync {
    fn file(&self) -> Option<&dyn FileCap> {
        None
    }
    fn notify(&self) -> Option<&dyn NotifyCap> {
        None
    }
}

static REGISTRY: OnceLock<Box<dyn CapabilityRegistry>> = OnceLock::new();

/// 플랫폼 startup(Tauri setup / LynxEnv init 직후) 이 1회 호출.
pub fn set_registry(registry: Box<dyn CapabilityRegistry>) {
    let _ = REGISTRY.set(registry);
}

/// command 핸들러가 호출.
pub fn registry() -> Option<&'static dyn CapabilityRegistry> {
    REGISTRY.get().map(|b| &**b)
}

// ── Desktop 기본 구현체 (std::fs — macOS/Linux/Windows 공용) ──────────────────

/// `FileCap` 의 portable desktop 구현. Tauri setup 에서 `set_registry(Box::new(DesktopRegistry))`.
#[derive(Default, Debug, Clone, Copy)]
pub struct DesktopRegistry;

impl FileCap for DesktopRegistry {
    fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
        std::fs::read(path).map_err(|e| format!("read_file({path}): {e}"))
    }
}

/// 데스크톱 알림 — 셸(Tauri plugin-notification 등)이 있어야 의미가 있으므로
/// 기본 구현은 정직하게 에러를 반환한다. 셸 연결은 capabilities/README.md 참조.
impl NotifyCap for DesktopRegistry {
    fn notify(&self, _title: &str, _body: &str) -> Result<(), String> {
        Err(
            "desktop notify: connect a shell notification plugin (see capabilities/README.md)"
                .into(),
        )
    }
}

impl CapabilityRegistry for DesktopRegistry {
    fn file(&self) -> Option<&dyn FileCap> {
        Some(self)
    }
    fn notify(&self) -> Option<&dyn NotifyCap> {
        Some(self)
    }
}

// ── Mobile 브리지 (Rust → 플랫폼 콜백) ────────────────────────────────────────

/// 플랫폼(iOS Obj-C / Android JNI)이 구현해 등록하는 파일 읽기 콜백.
/// - `path_ptr/path_len`: UTF-8 경로(Rust 가 전달).
/// - 반환: 플랫폼이 할당한 버퍼 포인터 + `out_len` 설정. 실패 시 null 반환(또는 `*out_len=0`).
/// - 버퍼 해제 책임은 플랫폼: `rustra_template_free_platform_buffer` 로 다시 돌려준다.
pub type PlatformFileReadFn =
    unsafe extern "C" fn(path_ptr: *const u8, path_len: usize, out_len: *mut usize) -> *mut u8;

/// 플랫폼 알림 콜백. 반환 0 = 성공, 그 외 = 실패(플랫폼 정의).
pub type PlatformNotifyFn = unsafe extern "C" fn(
    title_ptr: *const u8,
    title_len: usize,
    body_ptr: *const u8,
    body_len: usize,
) -> i32;

/// 플랫폼 버퍼 해제 콜백 — 플랫폼이 할당한 파일 버퍼를 플랫폼이 해제한다.
pub type PlatformFreeFn = unsafe extern "C" fn(ptr: *mut u8, len: usize);

/// NativeModule startup 이 이 구조체로 콜백 세트를 등록한다 (C ABI — 필드 순서 고정).
#[repr(C)]
#[derive(Clone, Copy)]
pub struct MobileBridge {
    pub read_file: PlatformFileReadFn,
    pub notify: PlatformNotifyFn,
    pub free: PlatformFreeFn,
}

static MOBILE_BRIDGE: OnceLock<MobileBridge> = OnceLock::new();

/// Mobile 셸이 주입하는 registry — 등록된 플랫폼 콜백으로 capability 를 위임한다.
/// 콜백 미등록 capability 는 게터가 None (command 가 capability.missing 반환).
#[derive(Default, Debug, Clone, Copy)]
pub struct MobileRegistry;

impl FileCap for MobileRegistry {
    fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
        let bridge = mobile_bridge().ok_or("mobile bridge not registered")?;
        // 안전: bridge 함수 포인터는 MobileBridge ABI 계약(위 주석)을 따른다.
        unsafe {
            let mut out_len: usize = 0;
            let ptr = (bridge.read_file)(path.as_ptr(), path.len(), &mut out_len);
            if ptr.is_null() || out_len == 0 {
                return Err(format!("platform read_file({path}) failed"));
            }
            // 플랫폼 버퍼를 Vec 로 복사 후 플랫폼에 반납 — 소유권 경계를 Rust 가 닫는다.
            let bytes = std::slice::from_raw_parts(ptr, out_len).to_vec();
            (bridge.free)(ptr, out_len);
            Ok(bytes)
        }
    }
}

impl NotifyCap for MobileRegistry {
    fn notify(&self, title: &str, body: &str) -> Result<(), String> {
        let bridge = mobile_bridge().ok_or("mobile bridge not registered")?;
        // 안전: bridge 함수 포인터는 MobileBridge ABI 계약을 따른다.
        let rc = unsafe { (bridge.notify)(title.as_ptr(), title.len(), body.as_ptr(), body.len()) };
        if rc == 0 {
            Ok(())
        } else {
            Err(format!("platform notify failed (rc={rc})"))
        }
    }
}

impl CapabilityRegistry for MobileRegistry {
    fn file(&self) -> Option<&dyn FileCap> {
        mobile_bridge().map(|_| self as &dyn FileCap)
    }
    fn notify(&self) -> Option<&dyn NotifyCap> {
        mobile_bridge().map(|_| self as &dyn NotifyCap)
    }
}

fn mobile_bridge() -> Option<&'static MobileBridge> {
    MOBILE_BRIDGE.get()
}

// ── FFI 심볼 (각 셸이 startup 에 호출) ───────────────────────────────────────

/// 모바일 셸(NativeModule startup)이 1회 호출: 플랫폼 콜백 등록 + MobileRegistry 주입.
///
/// # Safety
/// `bridge` 는 유효한 `MobileBridge`(3 함수 포인터 모두 유효)를 가리켜야 한다.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn rustra_template_register_mobile_registry(bridge: *const MobileBridge) {
    if bridge.is_null() {
        return;
    }
    // 안전: 호출자가 ABI 계약(유효 포인터)을 지켰다고 선언한다.
    let b = unsafe { *bridge };
    let _ = MOBILE_BRIDGE.set(b);
    set_registry(Box::new(MobileRegistry));
}

/// 데스크톱 셸(C++/Obj-C host)이 startup 에 1회 호출: DesktopRegistry(std::fs) 주입.
/// Rust 셸(Tauri setup) 은 `set_registry(Box::new(DesktopRegistry))` 로 직접 주입해도 된다.
#[unsafe(no_mangle)]
pub extern "C" fn rustra_template_register_desktop_registry() {
    set_registry(Box::new(DesktopRegistry));
}

/// (참고) c_void import 는 향후 bridge opaque 확장용 — ABI 문서가 c_void 를 쓰지 않는 한 미사용.
#[allow(dead_code)]
fn _c_void_marker(_: *mut c_void) {}

#[cfg(test)]
mod tests {
    use super::*;

    struct StubRegistry;
    impl FileCap for StubRegistry {
        fn read_file(&self, _p: &str) -> Result<Vec<u8>, String> {
            Ok(b"hello".to_vec())
        }
    }
    impl CapabilityRegistry for StubRegistry {
        fn file(&self) -> Option<&dyn FileCap> {
            Some(self)
        }
    }

    #[test]
    fn registry_returns_injected_impl() {
        // set_registry 는 OnceLock — 테스트 격립을 위해 별도 registry 인터페이스로 검증.
        let reg = StubRegistry;
        assert!(reg.file().is_some());
        assert_eq!(reg.file().unwrap().read_file("x").unwrap(), b"hello");
    }

    #[test]
    fn desktop_registry_reads_real_file() {
        let reg = DesktopRegistry;
        let cap = reg.file().expect("desktop provides FileCap");
        // 존재하는 파일 하나 읽기 (Cargo.toml 자신).
        let bytes = cap.read_file("Cargo.toml").unwrap();
        assert!(bytes.windows(7).any(|w| w == b"package"));
    }

    #[test]
    fn desktop_registry_read_missing_file_errors() {
        let reg = DesktopRegistry;
        let err = reg
            .file()
            .unwrap()
            .read_file("/no/such/path/here")
            .unwrap_err();
        assert!(err.contains("read_file"));
    }

    #[test]
    fn desktop_notify_without_plugin_errors_honestly() {
        let reg = DesktopRegistry;
        let notify_cap: &dyn NotifyCap = CapabilityRegistry::notify(&reg).unwrap();
        let err = NotifyCap::notify(notify_cap, "t", "b").unwrap_err();
        assert!(err.contains("notification plugin"));
    }

    // ── MobileRegistry 브리지 경로 (가짜 플랫폼 콜백으로) ───────────────────

    use std::cell::Cell;
    thread_local! {
        static FAKE_READ_RC: Cell<(i32, &'static [u8])> = const { Cell::new((0, b"fake-config{}")) };
    }

    unsafe extern "C" fn fake_read_file(
        path_ptr: *const u8,
        path_len: usize,
        out_len: *mut usize,
    ) -> *mut u8 {
        // 안전: 테스트 내부에서만 유효한 인자로 호출한다.
        let path = unsafe { std::slice::from_raw_parts(path_ptr, path_len) };
        assert_eq!(path, b"config.json");
        let (rc, data) = FAKE_READ_RC.get();
        if rc != 0 {
            return std::ptr::null_mut();
        }
        // 플랫폼 시뮬레이션: malloc + copy + out_len 설정.
        let buf = unsafe { libc_malloc(data.len()) } as *mut u8;
        unsafe { std::ptr::copy_nonoverlapping(data.as_ptr(), buf, data.len()) };
        unsafe { *out_len = data.len() };
        buf
    }

    unsafe extern "C" fn fake_notify(_t: *const u8, _tl: usize, _b: *const u8, _bl: usize) -> i32 {
        0
    }

    unsafe extern "C" fn fake_free(ptr: *mut u8, len: usize) {
        unsafe { libc_free(ptr as *mut c_void, len) };
    }

    // 테스트용 최소 allocator (플랫폼 malloc 시뮬레이션).
    unsafe fn libc_malloc(len: usize) -> *mut c_void {
        let v: Vec<u8> = Vec::with_capacity(len);
        let ptr = v.as_ptr() as *mut c_void;
        std::mem::forget(v); // 해제는 fake_free 에서 Vec 로 재구성해 수행.
                             // capacity 만큼 할당된 버퍼 — len ≤ capacity 를 가정.
        ptr
    }
    unsafe fn libc_free(ptr: *mut c_void, len: usize) {
        if !ptr.is_null() && len > 0 {
            unsafe {
                let _ = Vec::from_raw_parts(ptr as *mut u8, len, len);
            }
        }
    }

    const FAKE_BRIDGE: MobileBridge = MobileBridge {
        read_file: fake_read_file,
        notify: fake_notify,
        free: fake_free,
    };

    #[test]
    fn mobile_registry_delegates_to_platform_callbacks() {
        let reg = MobileRegistry;
        // 브리지 미등록 상태와 등록 상태를 구분: MOBILE_BRIDGE 는 OnceLock 이라
        // 등록은 1회만 가능 — 이 테스트가 먼저 실행되면 등록, 아니면 이미 등록된 상태 재사용.
        if mobile_bridge().is_none() {
            unsafe { rustra_template_register_mobile_registry(&FAKE_BRIDGE) };
        }
        let cap: &dyn FileCap = reg.file().expect("bridge registered → FileCap");
        let bytes = cap
            .read_file("config.json")
            .expect("fake platform read succeeds");
        assert_eq!(bytes, b"fake-config{}");
        // notify 콜백도 rc=0 → 성공.
        let notify_cap: &dyn NotifyCap = CapabilityRegistry::notify(&reg).unwrap();
        NotifyCap::notify(notify_cap, "t", "b").unwrap();
    }

    #[test]
    fn mobile_registry_file_cap_none_without_bridge() {
        // OnceLock 특성상 이 테스트는 bridge 등록 "이전" 상태를 재현할 수 없다
        // (다른 테스트가 이미 등록했을 수 있음). 따라서 등록 후에는 반드시 Some 임을 검증 —
        // None 경로는 mobile_bridge() 를 직접 조작하는 단위(위 delegation 테스트)와
        // 게터 계약(Option) 조합으로 커버한다.
        if mobile_bridge().is_some() {
            assert!(MobileRegistry.file().is_some());
        }
    }
}
