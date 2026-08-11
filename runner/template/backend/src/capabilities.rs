//! Platform-native capability 추상 (design §4 계층 B).
//!
//! Rust command 는 플랫폼 디바이스 API(file/notify/camera)를 직접 부를 수 없다
//! (모바일 샌드박스·권한). 대신 trait 로 추상하고, 플랫폼이 startup 에 구현체를 주입한다.
//!
//! - command 핸들러: `registry().and_then(|r| r.file())` 로만 디바이스 접근. 구현체 모름.
//! - Desktop(Tauri): `DesktopRegistry`(std::fs) 를 setup 에서 `set_registry()` 로 주입.
//! - Mobile(iOS/Android): `MobileRegistry` 가 Rust→플랫폼 콜백 브리지로 구현
//!   (NativeModule 이 FFI 콜백 등록 → Java/Obj-C API 위임). `capabilities/README.md` 참조.
//!
//! 새 capability 추가 = (1) trait + Registry 게터, (2) Desktop 구현체, (3) 디바이스면 Mobile 브리지.

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

impl CapabilityRegistry for DesktopRegistry {
    fn file(&self) -> Option<&dyn FileCap> {
        Some(self)
    }
    // notify() 는 None — 데스크톱 알림은 Tauri plugin 으로 별도 주입 시 여기에 추가.
}

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
}
