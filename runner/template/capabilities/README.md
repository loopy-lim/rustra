# Capability 확장 패턴 (계층 B)

rustra runner 템플릿의 capability 는 **2계층** 이다. 이 문서는 플랫폼 디바이스 API에
접근하는 **계층 B**(platform-native capability trait) 의 사용·확장 방법을 설명한다.

> 계층 A(rustra 자체의 `require_capability` + deny-by-default authority)는 플랫폼 중립이며
> 추가 구현 불필. `secureCompute` 가 그 예. design §4 참조.

## 왜 trait 인가

Rust command 핸들러는 모바일 샌드박스·권한 때문에 디바이스 API(file/notify/camera)를
직접 부를 수 없다. 대신 **trait 메서드**로 추상하고, 플랫폼이 startup 에 구현체를 주입한다.
command 핸들러는 구현체를 모른 채 `registry().and_then(|r| r.file())` 로만 접근한다.

## 현재 제공 capability

| capability | trait       | Desktop                          | Mobile                                       |
| ---------- | ----------- | -------------------------------- | -------------------------------------------- |
| 파일 읽기  | `FileCap`   | `std::fs` (DesktopRegistry)      | **브리지 구현됨** — `MobileBridge.read_file` |
| 알림       | `NotifyCap` | 정직 에러(셸 plugin 연결 가이드) | **브리지 구현됨** — `MobileBridge.notify`    |

## 플랫폼 주입 방법

### Desktop (Tauri)

Tauri `setup` 단계에서 순수 Rust 로 주입 — 별도 FFI 불필요:

```rust
// desktop/src-tauri/src/main.rs — setup 클로저 안에 추가
rustra_template_backend::capabilities::set_registry(
    Box::new(rustra_template_backend::capabilities::DesktopRegistry),
);
```

`DesktopRegistry` 는 `FileCap` 을 `std::fs` 로 구현한다. `NotifyCap` 은 셸에 의존하므로
기본 구현이 정직하게 에러를 반환한다 — `tauri-plugin-notification` 연결 시
`DesktopRegistry` 대신 자체 registry 를 주입한다.

### Mobile (iOS / Android)

NativeModule 이 startup 에 **`MobileBridge` C ABI 콜백 세트**를 등록한다:

```rust
// backend/src/capabilities.rs (이미 구현됨)
#[repr(C)]
pub struct MobileBridge {
    pub read_file: PlatformFileReadFn,  // (path_ptr, path_len, out_len) -> buf
    pub notify:    PlatformNotifyFn,    // (title, body) -> rc(0=ok)
    pub free:      PlatformFreeFn,      // 플랫폼이 할당한 버퍼 해제
}
```

**Android (JNI)** — `JNI_OnLoad` 에서 등록:

```cpp
// modules/rustra-lynx/android/src/main/cpp/rustra_jni.cpp
static uint8_t *read_file_cb(const uint8_t *path, size_t len, size_t *out_len) {
  // JNIEnv(Thread attach) 로 Context.openFileInput 위임 — 앱 영역 파일만.
}
static int32_t notify_cb(const uint8_t *title, size_t tl, const uint8_t *body, size_t bl) {
  // NotificationManagerCompat 로 위임 (POST_NOTIFICATIONS 권한 필요).
}
static void free_cb(uint8_t *p, size_t len) { /* 플랫폼 allocator 로 해제 */ }

static const rustra_bridge_t BRIDGE = { read_file_cb, notify_cb, free_cb };
jint JNI_OnLoad(JavaVM *vm, void *) {
  rustra_template_init();
  rustra_template_register_mobile_registry(&BRIDGE);  // ← MobileRegistry 주입됨
  return JNI_VERSION_1_6;
}
```

**iOS (Obj-C)** — `+[RustraModule load]` 또는 AppDelegate 에서 동일 구조로 등록
(`NSFileManager` / `UNUserNotificationCenter` 위임).

소유권 규칙: 플랫폼이 할당한 버퍼는 Rust 가 `Vec` 으로 복사한 뒤 **같은 브리지의 `free`**
로 플랫폼에 반납한다. Rust ↔ 플랫폼 allocator 절대 혼용 금지.

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

`MobileBridge` 에 콜백 필드를 추가하면 **ABI 가 바뀐다** — 이미 배포된 셸과 호환하려면
새 버전 심볼(예: `rustra_template_register_mobile_registry_v2`)을 별도 노출한다.

### 2. Desktop 구현체 (portable, `std`/Tauri plugin)

```rust
impl CameraCap for DesktopRegistry {
    fn take_photo(&self) -> Result<Vec<u8>, String> {
        // Tauri camera plugin 또는 AVFoundation 등 desktop API.
        Err("camera not implemented on desktop".into())
    }
}
impl CapabilityRegistry for DesktopRegistry {
    fn camera(&self) -> Option<&dyn CameraCap> { Some(self) }
}
```

### 3. 디바이스면 Mobile 브리지 (iOS/Android)

`MobileBridge` 에 콜백 추가 + 플랫폼 위임(AVCaptureSession / CameraX). 흐름:

```text
Rust command → registry().camera().take_photo()
                     ↓ (MobileBridge.camera 콜백)
              Android: CameraX / iOS: AVCaptureSession
                     ↓ (사진 bytes)
              Rust 로 반환 → command 결과
```

## 사용 예 (`backend/src/lib.rs`)

```rust
#[command]
pub fn read_config() -> Result<String> {
    let cap = capabilities::registry()
        .and_then(|r| r.file())
        .ok_or_else(|| RustraError::custom("capability.missing", "file capability not provided"))?;
    let bytes = cap.read_file("config.json").map_err(|e| RustraError::custom("io", e))?;
    Ok(String::from_utf8(bytes).map_err(|e| RustraError::custom("encoding", e.to_string()))?)
}
```

→ ReactLynx 는 코드 그대로(`readConfig()` 만 호출). design §4 "새 capability 추가 =
trait 메서드 + 플랫폼 구현체" 구현.

## 검증

- Rust 계층: `cargo test --manifest-path runner/template/backend/Cargo.toml`
  (MobileRegistry 위임 경로는 가짜 플랫폼 콜백 테스트로 검증 — 6 tests)
- 플랫폼 실장은 각 `run.sh` 런타임 게이트(iOS/Android)에서 실증.
