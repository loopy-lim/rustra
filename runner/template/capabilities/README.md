# Capability 확장 패턴 (계층 B)

rustra runner 템플릿의 capability 는 **2계층** 이다. 이 문서는 플랫폼 디바이스 API에
접근하는 **계층 B**(platform-native capability trait) 의 확장 방법을 설명한다.

> 계층 A(rustra 자체의 `require_capability` + deny-by-default authority)는 플랫폼 중립이며
> 추가 구현 불필요. `secureCompute` 가 그 예. design §4 참조.

## 왜 trait 인가

Rust command 핸들러는 모바일 샌드박스·권한 때문에 디바이스 API(file/notify/camera)를
직접 부를 수 없다. 대신 **trait 메서드**로 추상하고, 플랫폼이 startup 에 구현체를 주입한다.
command 핸들러는 구현체를 모른 채 `registry().and_then(|r| r.file())` 로만 접근한다.

## 새 capability 추가 — 3단계

### 1. trait + Registry 게터 (`backend/src/capabilities.rs`)

```rust
pub trait CameraCap: Send + Sync {
    fn take_photo(&self) -> Result<Vec<u8>, String>;
}

pub trait CapabilityRegistry: Send + Sync {
    // ...기존 게터들...
    fn camera(&self) -> Option<&dyn CameraCap> { None }
}
```

### 2. Desktop 구현체 (portable, `std`/Tauri plugin)

```rust
impl CameraCap for DesktopRegistry {
    fn take_photo(&self) -> Result<Vec<u8>, String> {
        // Tauri camera plugin 또는 AVCaptureionsHIP 등 desktop API.
        Err("camera not implemented on desktop".into())
    }
}
impl CapabilityRegistry for DesktopRegistry {
    fn camera(&self) -> Option<&dyn CameraCap> { Some(self) }
}
```

### 3. 디바이스면 Mobile 브리지 (iOS/Android)

모바일은 Rust → 플랫폼 콜백 브리지로 구현한다. NativeModule 이 startup 에 FFI 콜백을 등록하면,
`MobileRegistry::take_photo` 가 그 콜백을 호출해 플랫폼 API(AVCaptureSession / CameraX)로 위임한다.

```text
Rust command → registry().camera().take_photo()
                     ↓ (FFI callback: rustra_camera_callback)
              Android: CameraX / iOS: AVCaptureSession
                     ↓ (사진 bytes)
              Rust 로 반환 → command 결과
```

FFI 콜백 등록 형태(`backend/src/capabilities.rs` 에 추가):

```rust
type CameraCallback = unsafe extern "C" fn() -> *mut u8;  // 단순화
static CAMERA_CB: OnceLock<CameraCallback> = OnceLock::new();
pub fn set_camera_callback(cb: CameraCallback) { let _ = CAMERA_CB.set(cb); }
```

## 사용 예 (`backend/src/lib.rs`)

```rust
#[command]
pub fn snapshot() -> Result<Vec<u8>> {
    let cap = capabilities::registry()
        .and_then(|r| r.camera())
        .ok_or_else(|| RustraError::custom("capability.missing", "camera not provided"))?;
    cap.take_photo().map_err(|e| RustraError::custom("camera", e))
}
```

→ ReactLynx 는 코드 그대로(`snapshot()` 만 호출). design §4 "새 capability 추가 = trait 메서드 + 플랫폼 구현체" 구현.

## 현재 제공 capability

| capability | trait       | Desktop                     | Mobile                         |
| ---------- | ----------- | --------------------------- | ------------------------------ |
| 파일 읽기  | `FileCap`   | `std::fs` (DesktopRegistry) | 브리지(미구현, 본 문서 가이드) |
| 알림       | `NotifyCap` | Tauri plugin (미구현)       | 브리지(미구현)                 |
